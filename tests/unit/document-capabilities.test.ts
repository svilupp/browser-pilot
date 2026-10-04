import { expect, test } from 'bun:test';
import { CapabilityCache } from '../../src/browser/capabilities.ts';
import { Page } from '../../src/browser/page.ts';
import type { CDPClient } from '../../src/cdp/client.ts';
import { createCDPClient } from '../../src/cdp/client.ts';
import type { Transport } from '../../src/cdp/transport.ts';

test('document capability evidence expires while lifecycle evidence remains and copies cannot alter cache', () => {
  const cache = new CapabilityCache('browser-1', '@fixture');
  const evidence = {
    state: 'verified' as const,
    probeVersion: 'fixture-v1',
    observedAt: new Date().toISOString(),
    evidence: 'disposable input received exactly once',
  };
  cache.record('input', evidence, 2);
  cache.record('release', { ...evidence, evidence: 'allocation disappeared' });
  expect(cache.get('input', 3)).toBeUndefined();
  const copy = cache.get('input', 2)!;
  copy.state = 'degraded';
  expect(cache.get('input', 2)?.state).toBe('verified');
  cache.invalidateDocument();
  expect(cache.get('input', 2)).toBeUndefined();
  expect(cache.get('release')?.browserGeneration).toBe('browser-1');
});

function fixture() {
  const events = new Map<string, (params: Record<string, unknown>) => void>();
  const sent: string[] = [];
  const cdp = {
    send: async (method: string) => {
      sent.push(method);
      if (method === 'Accessibility.getPartialAXTree')
        return {
          nodes: [{ backendDOMNodeId: 42, role: { value: 'button' }, name: { value: 'Pay' } }],
        };
      return {};
    },
    on: (event: string, handler: (params: Record<string, unknown>) => void) =>
      events.set(event, handler),
    off: (event: string) => events.delete(event),
  } as unknown as CDPClient;
  return { page: new Page(cdp, 'page'), events, sent };
}

test('same backend node with changed meaning fails before input and clears old refs', async () => {
  const { page, sent } = fixture();
  page.importRefMap({ e1: 42 }, { e1: { role: 'button', name: 'Continue' } });
  await expect(page.click('ref:e1', { timeout: 100 })).rejects.toMatchObject({
    capability: 'STALE_REF',
  });
  expect(sent.some((method) => method.startsWith('Input.'))).toBe(false);
  expect(page.exportRefMap()).toEqual({});
});

test('SPA route event invalidates refs and document capability evidence, with listeners removed on dispose', async () => {
  const { page, events } = fixture();
  await page.init();
  page.importRefMap({ e1: 42 });
  page.capabilities.record(
    'input',
    {
      state: 'verified',
      probeVersion: 'fixture',
      observedAt: new Date().toISOString(),
      evidence: 'fixture',
    },
    page.documentGeneration
  );
  events.get('Page.navigatedWithinDocument')?.({
    frameId: 'main',
    url: 'https://fixture.test/next',
  });
  expect(page.documentGeneration).toBeGreaterThan(0);
  expect(page.exportRefMap()).toEqual({});
  expect(page.capabilities.report(page.documentGeneration)).toEqual([]);
  page.dispose();
  expect(events.size).toBe(0);
});

test('connection handshake budget does not shrink subsequent command budget', async () => {
  let listener: ((raw: string) => void) | undefined;
  const transport: Transport = {
    send(raw) {
      const request = JSON.parse(raw) as { id: number };
      setTimeout(
        () => listener?.(JSON.stringify({ id: request.id, result: { product: 'fixture' } })),
        20
      );
    },
    async close() {},
    onMessage(fn) {
      listener = fn;
    },
    onClose() {},
    onError() {},
  };
  const client = await createCDPClient('wss://fixture.test', {
    timeout: 5,
    commandTimeout: 100,
    transportFactory: async (_url, options) => {
      expect(options?.timeout).toBe(5);
      return transport;
    },
  });
  try {
    expect(await client.send<{ product: string }>('Browser.getVersion')).toEqual({
      product: 'fixture',
    });
  } finally {
    await client.close();
  }
});
