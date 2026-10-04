import { describe, expect, test } from 'bun:test';
import { CloudflareProvider } from '../../src/providers/cloudflare.ts';
import { createProvider } from '../../src/providers/factory.ts';
import {
  assertProviderConstraint,
  normalizeProviderSelector,
} from '../../src/providers/selector.ts';

const base = 'https://api.cloudflare.com/client/v4/accounts/account/browser-run/devtools/browser';
const ws = `${base}/allocation`.replace('https:', 'wss:');
function provider(responses: Array<Response | Error>, extra = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const p = new CloudflareProvider({
    accountId: 'account',
    apiKey: 'secret',
    ...extra,
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error('Unexpected request');
      return response;
    }) as typeof fetch,
  });
  return { p, calls };
}

describe('Cloudflare provider contract', () => {
  test('selector normalization distinguishes defaults from explicit constraints', () => {
    expect(normalizeProviderSelector('cloudflare')).toEqual({
      provider: 'cloudflare',
      engine: 'chromium',
      explicitEngine: false,
    });
    expect(normalizeProviderSelector('cloudflare:kitesurf').explicitEngine).toBe(true);
    for (const value of [
      '',
      'cloudflare:',
      'cloudflare:unknown',
      'cloudflare:kitesurf:extra',
      'browserbase:kitesurf',
    ])
      expect(() => normalizeProviderSelector(value)).toThrow('Invalid provider selector');
    expect(() => assertProviderConstraint('cloudflare', 'cloudflare', 'kitesurf')).not.toThrow();
    expect(() =>
      assertProviderConstraint('cloudflare:chromium', 'cloudflare', 'kitesurf')
    ).toThrow();
  });
  test('bad selectors and Kitesurf options fail before credential access/I/O', () => {
    let reads = 0;
    expect(() =>
      createProvider({ provider: 'cloudflare:bad' } as never, {
        secrets: {
          get: () => {
            reads++;
            return undefined;
          },
        },
      })
    ).toThrow();
    expect(reads).toBe(0);
    expect(
      () =>
        new CloudflareProvider({
          accountId: 'account',
          apiKey: 'secret',
          engine: 'kitesurf',
          lab: false,
        })
    ).toThrow('Kitesurf');
    for (const keepAliveMs of [9999, 1200001, NaN, 10000.5])
      expect(
        () => new CloudflareProvider({ accountId: 'account', apiKey: 'secret', keepAliveMs })
      ).toThrow('keepAliveMs');
  });
  test('bare allocation shape, exact authenticated socket and pending release retry', async () => {
    const { p, calls } = provider(
      [
        Response.json({ sessionId: 'allocation', webSocketDebuggerUrl: ws }),
        Response.json({ status: 'closing' }),
        Response.json({ status: 'closed' }),
      ],
      { keepAliveMs: 10000 }
    );
    const session = await p.createSession();
    expect(calls[0]?.url).toBe(`${base}?keep_alive=10000`);
    expect(session.connection).toEqual({
      kind: 'url',
      url: ws,
      headers: { Authorization: 'Bearer secret' },
    });
    expect(JSON.stringify(session.metadata)).not.toContain('secret');
    expect(await session.close()).toMatchObject({ status: 'cleanup_pending' });
    expect(await session.close()).toMatchObject({ status: 'released', allocationId: 'allocation' });
    await session.close();
    expect(calls).toHaveLength(3);
  });
  test('malicious endpoint is rejected and provisional allocation released', async () => {
    const { p, calls } = provider([
      Response.json({ sessionId: 'allocation', webSocketDebuggerUrl: 'wss://evil.test/token' }),
      new Response(null, { status: 404 }),
    ]);
    await expect(p.createSession()).rejects.toThrow('invalid authenticated endpoint');
    expect(calls.map((c) => c.url)).toEqual([base, `${base}/allocation`]);
    expect(calls[1]?.init?.method).toBe('DELETE');
  });
  test('live legacy Browser Rendering endpoint retains exact account and allocation checks', async () => {
    const legacy = ws.replace('/browser-run/', '/browser-rendering/');
    const { p } = provider([
      Response.json({ sessionId: 'allocation', webSocketDebuggerUrl: legacy }),
      Response.json({ status: 'closed' }),
    ]);
    const session = await p.createSession();
    expect(session.connection).toEqual({
      kind: 'url',
      url: legacy,
      headers: { Authorization: 'Bearer secret' },
    });
    expect(await session.close()).toMatchObject({ status: 'released' });
    for (const invalid of [`${legacy}?token=secret`, legacy.replace('/allocation', '/other')]) {
      const { p: rejected } = provider([
        Response.json({ sessionId: 'allocation', webSocketDebuggerUrl: invalid }),
        new Response(null, { status: 404 }),
      ]);
      await expect(rejected.createSession()).rejects.toThrow('invalid authenticated endpoint');
    }
  });
  test('attach borrows, never allocates or deletes external resources', async () => {
    const { p, calls } = provider([]);
    const session = await p.resumeSession('allocation');
    expect(session.wsUrl).toBe(ws);
    expect(session.metadata?.['requestedEngine']).toBeUndefined();
    expect(session.lifecycle?.ownership).toBe('borrowed');
    await session.close();
    expect(calls).toHaveLength(0);
  });
  test('Kitesurf uses one launch URL, fresh identity and no HTTP', async () => {
    const { p, calls } = provider([], { engine: 'kitesurf' });
    const a = await p.createSession();
    const b = await p.createSession();
    expect(a.wsUrl).toBe(`${base.replace('https:', 'wss:')}?browser=kitesurf`);
    expect(a.metadata?.['browserGeneration']).not.toBe(b.metadata?.['browserGeneration']);
    expect(a.lifecycle?.reconnectable).toBe(false);
    await expect(p.resumeSession('anything')).rejects.toThrow('Kitesurf');
    expect(calls).toHaveLength(0);
  });
  test('ambiguous POST is not retried and errors redact the token', async () => {
    const { p, calls } = provider([new Error('secret')]);
    await expect(p.createSession()).rejects.toMatchObject({ capability: 'allocation_unknown' });
    expect(calls).toHaveLength(1);
  });
  test('release HTTP failures stay pending and simultaneous closes share one DELETE', async () => {
    const { p, calls } = provider(
      [new Response(null, { status: 503 }), new Response(null, { status: 410 })],
      { takeOwnership: true }
    );
    const session = await p.resumeSession('allocation');
    const [a, b] = await Promise.all([session.close(), session.close()]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ status: 'cleanup_pending' });
    expect(calls).toHaveLength(1);
    expect(await session.close()).toMatchObject({ status: 'already_released' });
  });
});

test('HTTP allocation failures are single attempts with redacted, explicit ambiguity', async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const { p, calls } = provider([new Response('secret reflected body', { status })]);
    let error: unknown;
    try {
      await p.createSession();
    } catch (caught) {
      error = caught;
    }
    expect(calls).toHaveLength(1);
    expect(String(error)).not.toContain('secret');
    expect(error).toMatchObject({
      capability: status >= 500 ? 'allocation_unknown' : 'provider-http',
    });
  }
});
