import { afterEach, describe, expect, test } from 'bun:test';
import { BrowserUseProvider } from '../../src/providers/browser-use.ts';
import { createProvider } from '../../src/providers/index.ts';

const FAKE_API_KEY = 'bu_test_key_123';
const BASE_URL = 'https://api.browser-use.com/api/v2';

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-abc-123',
    status: 'active',
    cdpUrl: 'wss://cdp.browser-use.com/sess-abc-123',
    liveUrl: 'https://live.browser-use.com/sess-abc-123',
    timeoutAt: '2026-03-22T12:00:00Z',
    startedAt: '2026-03-22T11:00:00Z',
    ...overrides,
  };
}

describe('BrowserUseProvider', () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl: string;
  let capturedInit: RequestInit;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(responseBody: unknown, status = 200) {
    // @ts-expect-error minimal mock
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init ?? {};
      return new Response(JSON.stringify(responseBody), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  }

  function mockFetchText(responseText: string, status: number) {
    // @ts-expect-error minimal mock
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init ?? {};
      return new Response(responseText, { status });
    };
  }

  // ── Session creation ────────────────────────────────────────────────

  describe('createSession', () => {
    test('sends POST to /api/v2/browsers', async () => {
      mockFetch(makeSession());
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY });
      await provider.createSession();

      expect(capturedUrl).toBe(`${BASE_URL}/browsers`);
      expect(capturedInit.method).toBe('POST');
    });

    test('sends X-Browser-Use-API-Key header', async () => {
      mockFetch(makeSession());
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY });
      await provider.createSession();

      const headers = capturedInit.headers as Record<string, string>;
      expect(headers['X-Browser-Use-API-Key']).toBe(FAKE_API_KEY);
      expect(headers['Content-Type']).toBe('application/json');
    });

    test('sends proxyCountryCode uk by default', async () => {
      mockFetch(makeSession());
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY });
      await provider.createSession();

      const body = JSON.parse(capturedInit.body as string);
      expect(body.proxyCountryCode).toBe('uk');
    });

    test('maps width/height to browserScreenWidth/browserScreenHeight', async () => {
      mockFetch(makeSession());
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY });
      await provider.createSession({ width: 1920, height: 1080 });

      const body = JSON.parse(capturedInit.body as string);
      expect(body.browserScreenWidth).toBe(1920);
      expect(body.browserScreenHeight).toBe(1080);
    });

    test('returns wsUrl from cdpUrl, sessionId from id, liveUrl in metadata', async () => {
      const session = makeSession();
      mockFetch(session);
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY });
      const result = await provider.createSession();

      expect(result.wsUrl).toBe(session.cdpUrl);
      expect(result.sessionId).toBe(session.id);
      expect(result.metadata?.['liveUrl']).toBe(session.liveUrl);
    });
  });

  // ── Proxy behavior ──────────────────────────────────────────────────

  describe('proxy behavior', () => {
    test('default proxy is uk when no proxyCountryCode specified', async () => {
      mockFetch(makeSession());
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY });
      await provider.createSession();

      const body = JSON.parse(capturedInit.body as string);
      expect(body.proxyCountryCode).toBe('uk');
    });

    test('explicit proxyCountryCode de sends de', async () => {
      mockFetch(makeSession());
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY, proxyCountryCode: 'de' });
      await provider.createSession();

      const body = JSON.parse(capturedInit.body as string);
      expect(body.proxyCountryCode).toBe('de');
    });

    test('explicit proxyCountryCode null sends null (disables proxy)', async () => {
      mockFetch(makeSession());
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY, proxyCountryCode: null });
      await provider.createSession();

      const body = JSON.parse(capturedInit.body as string);
      expect(body.proxyCountryCode).toBeNull();
    });
  });

  // ── Custom proxy ────────────────────────────────────────────────────

  describe('custom proxy', () => {
    test('customProxy object is forwarded in request body', async () => {
      const customProxy = {
        host: 'proxy.example.com',
        port: 8080,
        username: 'user',
        password: 'pass',
      };
      mockFetch(makeSession());
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY, customProxy });
      await provider.createSession();

      const body = JSON.parse(capturedInit.body as string);
      expect(body.customProxy).toEqual(customProxy);
    });
  });

  // ── Profile and timeout ─────────────────────────────────────────────

  describe('profile and timeout', () => {
    test('profileId forwarded in request body', async () => {
      mockFetch(makeSession());
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY, profileId: 'prof-1' });
      await provider.createSession();

      const body = JSON.parse(capturedInit.body as string);
      expect(body.profileId).toBe('prof-1');
    });

    test('timeout forwarded in request body', async () => {
      mockFetch(makeSession());
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY, timeout: 120 });
      await provider.createSession();

      const body = JSON.parse(capturedInit.body as string);
      expect(body.timeout).toBe(120);
    });
  });

  // ── Session resumption ──────────────────────────────────────────────

  describe('resumeSession', () => {
    test('calls GET /browsers/{id}', async () => {
      mockFetch(makeSession());
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY });
      await provider.resumeSession('sess-abc-123');

      expect(capturedUrl).toBe(`${BASE_URL}/browsers/sess-abc-123`);
      // GET is the default method — no explicit method set
      expect(capturedInit.method).toBeUndefined();
    });

    test('returns correct wsUrl and sessionId', async () => {
      const session = makeSession();
      mockFetch(session);
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY });
      const result = await provider.resumeSession('sess-abc-123');

      expect(result.wsUrl).toBe(session.cdpUrl);
      expect(result.sessionId).toBe(session.id);
    });

    test('throws if session is stopped (no cdpUrl)', async () => {
      mockFetch(makeSession({ status: 'stopped', cdpUrl: null }));
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY });

      await expect(provider.resumeSession('sess-abc-123')).rejects.toThrow(
        'not active or does not have a cdpUrl'
      );
    });
  });

  // ── Session close ───────────────────────────────────────────────────

  describe('close', () => {
    test('close() calls PATCH /browsers/{id} with action stop', async () => {
      const session = makeSession();
      mockFetch(session);
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY });
      const result = await provider.createSession();

      // Reset mock to capture the close call
      let closeUrl = '';
      let closeInit: RequestInit = {};
      // @ts-expect-error minimal mock
      globalThis.fetch = async (url: string, init?: RequestInit) => {
        closeUrl = url;
        closeInit = init ?? {};
        return new Response('{}', { status: 200 });
      };

      await result.close();

      expect(closeUrl).toBe(`${BASE_URL}/browsers/sess-abc-123`);
      expect(closeInit.method).toBe('PATCH');
      const body = JSON.parse(closeInit.body as string);
      expect(body.action).toBe('stop');
    });
  });

  // ── Error handling ──────────────────────────────────────────────────

  describe('error handling', () => {
    test('402 → insufficient credits message', async () => {
      mockFetchText('balance too low', 402);
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY });

      await expect(provider.createSession()).rejects.toThrow('insufficient credits');
    });

    test('403 → invalid API key message', async () => {
      mockFetchText('forbidden', 403);
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY });

      await expect(provider.createSession()).rejects.toThrow('invalid API key');
    });

    test('422 → includes validation details from response', async () => {
      mockFetchText('{"detail":"width must be positive"}', 422);
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY });

      await expect(provider.createSession()).rejects.toThrow('validation error');
    });

    test('429 → rate limit error', async () => {
      mockFetchText('too many requests', 429);
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY });

      await expect(provider.createSession()).rejects.toThrow('rate limit exceeded');
    });

    test('missing cdpUrl in response → throws', async () => {
      mockFetch(makeSession({ cdpUrl: null }));
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY });

      await expect(provider.createSession()).rejects.toThrow('does not have a cdpUrl');
    });

    test('network failure → throws', async () => {
      // @ts-expect-error minimal mock
      globalThis.fetch = async () => {
        throw new Error('Network error: ECONNREFUSED');
      };
      const provider = new BrowserUseProvider({ apiKey: FAKE_API_KEY });

      await expect(provider.createSession()).rejects.toThrow('Network error');
    });
  });

  // ── Factory integration ─────────────────────────────────────────────

  describe('factory integration', () => {
    test('createProvider with browser-use returns BrowserUseProvider', () => {
      const provider = createProvider({ provider: 'browser-use', apiKey: FAKE_API_KEY });
      expect(provider).toBeInstanceOf(BrowserUseProvider);
      expect(provider.name).toBe('browser-use');
    });

    test('missing API key and no env var → throws with helpful message', () => {
      expect(() => createProvider({ provider: 'browser-use' })).toThrow(
        'requires apiKey or BROWSER_USE_API_KEY env var'
      );
    });

    test('null proxyCountryCode passes through factory without defaulting to uk', async () => {
      mockFetch(makeSession());
      const provider = createProvider({
        provider: 'browser-use',
        apiKey: FAKE_API_KEY,
        proxyCountryCode: null,
      });
      await provider.createSession();
      const body = JSON.parse(capturedInit.body as string);
      expect(body.proxyCountryCode).toBeNull();
    });
  });
});
