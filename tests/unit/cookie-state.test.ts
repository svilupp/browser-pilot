/**
 * Unit tests for captureCookieState / restoreCookieState / resolveBrowserContextId
 * against a mock CDP client.
 */

import { describe, expect, test } from 'bun:test';
import {
  type CookieStatePage,
  captureCookieState,
  resolveBrowserContextId,
  restoreCookieState,
} from '../../src/auth/cookie-state.ts';
import { CookieStateError } from '../../src/auth/errors.ts';
import type { CdpNetworkCookie, CookieState, SerializedCookie } from '../../src/auth/types.ts';

interface Call {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string | null;
}

function createMockCdp(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  return {
    calls,
    async send<T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string | null
    ): Promise<T> {
      calls.push({ method, params, sessionId });
      if (method in responses) {
        const resp = responses[method];
        return typeof resp === 'function' ? (resp as (p?: unknown) => T)(params) : (resp as T);
      }
      return {} as T;
    },
    mock(method: string, response: unknown) {
      responses[method] = response;
    },
  };
}

function makePage(
  cdp: ReturnType<typeof createMockCdp>,
  opts: { targetId?: string; url?: string } = {}
): CookieStatePage {
  const url = opts.url ?? 'https://app.example.com/dashboard';
  return {
    cdpClient: cdp,
    targetId: opts.targetId ?? 'target-1',
    async url() {
      return url;
    },
  };
}

const DEFAULT_TARGETS = {
  targetInfos: [{ targetId: 'target-1', type: 'page', url: 'https://app.example.com/dashboard' }],
};

function cdpCookie(overrides: Partial<CdpNetworkCookie> = {}): CdpNetworkCookie {
  return {
    name: 'session',
    value: 'abc123',
    domain: '.example.com',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    priority: 'Medium',
    sourceScheme: 'Secure',
    sourcePort: 443,
    ...overrides,
  };
}

describe('resolveBrowserContextId', () => {
  test('uses browser-level send (sessionId null) for Target.getTargets', async () => {
    const cdp = createMockCdp({ 'Target.getTargets': DEFAULT_TARGETS });
    const page = makePage(cdp);
    await resolveBrowserContextId(page);
    const call = cdp.calls.find((c) => c.method === 'Target.getTargets');
    expect(call?.sessionId).toBeNull();
  });

  test('omits context id when target has no browserContextId (default context)', async () => {
    const cdp = createMockCdp({ 'Target.getTargets': DEFAULT_TARGETS });
    const page = makePage(cdp);
    const id = await resolveBrowserContextId(page);
    expect(id).toBeUndefined();
  });

  test('omits context id when context id is not in Target.getBrowserContexts list', async () => {
    const cdp = createMockCdp({
      'Target.getTargets': {
        targetInfos: [{ targetId: 'target-1', type: 'page', browserContextId: 'ctx-stale' }],
      },
      'Target.getBrowserContexts': { browserContextIds: ['ctx-other'] },
    });
    const page = makePage(cdp);
    const id = await resolveBrowserContextId(page);
    expect(id).toBeUndefined();
  });

  test('returns context id for a real non-default context', async () => {
    const cdp = createMockCdp({
      'Target.getTargets': {
        targetInfos: [{ targetId: 'target-1', type: 'page', browserContextId: 'ctx-1' }],
      },
      'Target.getBrowserContexts': { browserContextIds: ['ctx-1'] },
    });
    const page = makePage(cdp);
    const id = await resolveBrowserContextId(page);
    expect(id).toBe('ctx-1');
  });

  test('hard errors when the target is not found (never substitutes default context)', async () => {
    const cdp = createMockCdp({ 'Target.getTargets': { targetInfos: [] } });
    const page = makePage(cdp, { targetId: 'missing-target' });
    await expect(resolveBrowserContextId(page)).rejects.toBeInstanceOf(CookieStateError);
  });
});

describe('captureCookieState', () => {
  test('calls Storage.getCookies browser-level and omits context id by default', async () => {
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      'Storage.getCookies': { cookies: [cdpCookie()] },
    });
    const page = makePage(cdp);
    await captureCookieState(page);
    const call = cdp.calls.find((c) => c.method === 'Storage.getCookies');
    expect(call?.sessionId).toBeNull();
    expect(call?.params).toEqual({});
  });

  test('derives hostOnly from CDP leading-dot domain', async () => {
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      'Storage.getCookies': {
        cookies: [
          cdpCookie({ name: 'host-only', domain: 'app.example.com' }),
          cdpCookie({ name: 'domain-cookie', domain: '.example.com' }),
        ],
      },
    });
    const page = makePage(cdp);
    const state = await captureCookieState(page);
    const hostOnly = state.cookies.find((c) => c.name === 'host-only');
    const domainCookie = state.cookies.find((c) => c.name === 'domain-cookie');
    expect(hostOnly?.hostOnly).toBe(true);
    expect(hostOnly?.domain).toBe('app.example.com');
    expect(domainCookie?.hostOnly).toBe(false);
    expect(domainCookie?.domain).toBe('example.com');
  });

  test('maps expires <= 0 to null', async () => {
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      'Storage.getCookies': { cookies: [cdpCookie({ expires: -1 })] },
    });
    const page = makePage(cdp);
    const state = await captureCookieState(page);
    expect(state.cookies[0]?.expires).toBeNull();
  });

  test('drops unknown/CDP-only response fields via whitelist', async () => {
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      'Storage.getCookies': {
        cookies: [
          {
            ...cdpCookie(),
            size: 999,
            session: true,
            sameParty: true,
            futureField: 'whatever',
          },
        ],
      },
    });
    const page = makePage(cdp);
    const state = await captureCookieState(page);
    const cookie = state.cookies[0] as unknown as Record<string, unknown>;
    expect(cookie['size']).toBeUndefined();
    expect(cookie['session']).toBeUndefined();
    expect(cookie['sameParty']).toBeUndefined();
    expect(cookie['futureField']).toBeUndefined();
  });

  test('skips opaque partitioned cookies with a count (not surfaced in result, but excluded)', async () => {
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      'Storage.getCookies': {
        cookies: [cdpCookie(), cdpCookie({ name: 'opaque', partitionKeyOpaque: true })],
      },
    });
    const page = makePage(cdp);
    const state = await captureCookieState(page);
    expect(state.cookies.find((c) => c.name === 'opaque')).toBeUndefined();
    expect(state.cookies).toHaveLength(1);
  });

  test('fails with empty when no cookies match scope', async () => {
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      'Storage.getCookies': { cookies: [cdpCookie({ domain: 'other.com' })] },
    });
    const page = makePage(cdp);
    await expect(captureCookieState(page)).rejects.toMatchObject({ code: 'empty' });
  });

  test('rejects capture on about:blank (invalid_format)', async () => {
    const cdp = createMockCdp({ 'Target.getTargets': DEFAULT_TARGETS });
    const page = makePage(cdp, { url: 'about:blank' });
    await expect(captureCookieState(page)).rejects.toMatchObject({ code: 'invalid_format' });
  });

  test('fails when the page origin changed mid-capture (TOCTOU)', async () => {
    let calls = 0;
    const urls = ['https://app.example.com/dashboard', 'https://evil.com/'];
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      'Storage.getCookies': { cookies: [cdpCookie({ domain: '.example.com' })] },
    });
    const page: CookieStatePage = {
      cdpClient: cdp,
      targetId: 'target-1',
      async url() {
        return urls[calls++] ?? urls[urls.length - 1]!;
      },
    };
    await expect(captureCookieState(page)).rejects.toMatchObject({ code: 'invalid_format' });
  });

  test('fails on port-only navigation change (full origin, not just host+protocol)', async () => {
    let calls = 0;
    const urls = [
      'https://app.example.com:8443/dashboard',
      'https://app.example.com:9443/dashboard',
    ];
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      'Storage.getCookies': { cookies: [cdpCookie({ domain: '.example.com' })] },
    });
    const page: CookieStatePage = {
      cdpClient: cdp,
      targetId: 'target-1',
      async url() {
        return urls[calls++] ?? urls[urls.length - 1]!;
      },
    };
    await expect(captureCookieState(page)).rejects.toMatchObject({ code: 'invalid_format' });
  });

  test('reports navigation as invalid_format even when it would otherwise be empty', async () => {
    let calls = 0;
    const urls = ['https://app.example.com/dashboard', 'https://evil.com/'];
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      // No cookies match scope at all — would be `empty` if the origin check
      // ran after the empty check. Navigation must win.
      'Storage.getCookies': { cookies: [] },
    });
    const page: CookieStatePage = {
      cdpClient: cdp,
      targetId: 'target-1',
      async url() {
        return urls[calls++] ?? urls[urls.length - 1]!;
      },
    };
    const err = await captureCookieState(page).catch((e) => e);
    expect(err).toBeInstanceOf(CookieStateError);
    expect((err as CookieStateError).code).toBe('invalid_format');
    expect((err as CookieStateError).message).toContain('navigated during capture');
  });

  test('rejects unparsable includeUrls entries with invalid_format (never a raw TypeError)', async () => {
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      'Storage.getCookies': { cookies: [cdpCookie({ domain: '.example.com' })] },
    });
    const page = makePage(cdp);
    const err = await captureCookieState(page, { includeUrls: ['not a url'] }).catch((e) => e);
    expect(err).toBeInstanceOf(CookieStateError);
    expect((err as CookieStateError).code).toBe('invalid_format');
  });
});

function makeState(cookies: SerializedCookie[]): CookieState {
  return {
    format: 'browser-pilot-cookie-auth',
    schemaVersion: 1,
    savedAt: '2026-01-01T00:00:00.000Z',
    sourceUrl: 'https://app.example.com/dashboard',
    cookies,
  };
}

function serCookie(overrides: Partial<SerializedCookie> = {}): SerializedCookie {
  return {
    name: 'session',
    value: 'abc123',
    domain: 'example.com',
    hostOnly: false,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    expires: 4102444800,
    priority: 'Medium',
    sourceScheme: 'Secure',
    sourcePort: 443,
    ...overrides,
  };
}

describe('restoreCookieState', () => {
  test('calls Storage.setCookies browser-level with mapped params', async () => {
    const cookie = serCookie();
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      'Storage.getCookies': { cookies: [cdpCookie({ domain: '.example.com' })] },
    });
    const page = makePage(cdp);
    await restoreCookieState(page, makeState([cookie]));
    const call = cdp.calls.find((c) => c.method === 'Storage.setCookies');
    expect(call?.sessionId).toBeNull();
    const params = call?.params?.['cookies'] as Array<Record<string, unknown>>;
    expect(params[0]?.['domain']).toBe('.example.com');
    expect(params[0]?.['path']).toBe('/');
    expect(params[0]?.['url']).toBeUndefined();
  });

  test('host-only cookie uses synthetic url with no domain param', async () => {
    const cookie = serCookie({ hostOnly: true, domain: 'app.example.com', path: '/api' });
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      'Storage.getCookies': {
        cookies: [cdpCookie({ domain: 'app.example.com', path: '/api' })],
      },
    });
    const page = makePage(cdp);
    await restoreCookieState(page, makeState([cookie]));
    const call = cdp.calls.find((c) => c.method === 'Storage.setCookies');
    const params = call?.params?.['cookies'] as Array<Record<string, unknown>>;
    expect(params[0]?.['domain']).toBeUndefined();
    expect(params[0]?.['url']).toBe('https://app.example.com/api');
    expect(params[0]?.['path']).toBe('/api');
  });

  test('scheme for synthetic url derives from sourceScheme NonSecure', async () => {
    const cookie = serCookie({
      hostOnly: true,
      domain: 'app.example.com',
      secure: false,
      sourceScheme: 'NonSecure',
    });
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      'Storage.getCookies': { cookies: [cdpCookie({ domain: 'app.example.com' })] },
    });
    const page = makePage(cdp);
    await restoreCookieState(page, makeState([cookie]));
    const call = cdp.calls.find((c) => c.method === 'Storage.setCookies');
    const params = call?.params?.['cookies'] as Array<Record<string, unknown>>;
    expect(params[0]?.['url']).toBe('http://app.example.com/');
  });

  test('omits expires field for session cookies', async () => {
    const cookie = serCookie({ expires: null });
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      'Storage.getCookies': { cookies: [cdpCookie({ domain: '.example.com' })] },
    });
    const page = makePage(cdp);
    await restoreCookieState(page, makeState([cookie]));
    const call = cdp.calls.find((c) => c.method === 'Storage.setCookies');
    const params = call?.params?.['cookies'] as Array<Record<string, unknown>>;
    expect(params[0]?.['expires']).toBeUndefined();
  });

  test('skips expired cookies and counts them', async () => {
    const expired = serCookie({ name: 'expired', expires: 1 });
    const valid = serCookie({ name: 'valid' });
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      'Storage.getCookies': {
        cookies: [cdpCookie({ name: 'valid', domain: '.example.com' })],
      },
    });
    const page = makePage(cdp);
    const result = await restoreCookieState(page, makeState([expired, valid]));
    expect(result.skippedExpired).toBe(1);
    expect(result.restored).toBe(1);
  });

  test('zero cookies in state throws empty (before the expired check)', async () => {
    const cdp = createMockCdp({ 'Target.getTargets': DEFAULT_TARGETS });
    const page = makePage(cdp);
    await expect(restoreCookieState(page, makeState([]))).rejects.toMatchObject({ code: 'empty' });
  });

  test('all cookies expired throws expired', async () => {
    const cdp = createMockCdp({ 'Target.getTargets': DEFAULT_TARGETS });
    const page = makePage(cdp);
    await expect(
      restoreCookieState(page, makeState([serCookie({ expires: 1 })]))
    ).rejects.toMatchObject({ code: 'expired' });
  });

  test('read-back verification: full success reports zero unverified', async () => {
    const cookie = serCookie();
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      'Storage.getCookies': { cookies: [cdpCookie({ domain: '.example.com' })] },
    });
    const page = makePage(cdp);
    const result = await restoreCookieState(page, makeState([cookie]));
    expect(result.unverified).toBe(0);
    expect(result.restored).toBe(1);
    expect(result.domains).toEqual(['example.com']);
  });

  test('read-back verification: partial success resolves with unverified > 0', async () => {
    const a = serCookie({ name: 'a', domain: 'example.com' });
    const b = serCookie({ name: 'b', domain: 'other.com' });
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      // only "a" actually landed in the jar on read-back
      'Storage.getCookies': { cookies: [cdpCookie({ name: 'a', domain: '.example.com' })] },
    });
    const page = makePage(cdp);
    const result = await restoreCookieState(page, makeState([a, b]));
    expect(result.restored).toBe(2);
    expect(result.unverified).toBe(1);
  });

  test('read-back verification: zero verified throws nothing_restored', async () => {
    const cookie = serCookie();
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      'Storage.getCookies': { cookies: [] },
    });
    const page = makePage(cdp);
    await expect(restoreCookieState(page, makeState([cookie]))).rejects.toMatchObject({
      code: 'nothing_restored',
    });
  });

  test('never includes cookie values in the returned result', async () => {
    const cookie = serCookie({ value: 'super-secret-value' });
    const cdp = createMockCdp({
      'Target.getTargets': DEFAULT_TARGETS,
      'Storage.getCookies': { cookies: [cdpCookie({ domain: '.example.com' })] },
    });
    const page = makePage(cdp);
    const result = await restoreCookieState(page, makeState([cookie]));
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });
});
