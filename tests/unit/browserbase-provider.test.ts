import { afterEach, describe, expect, test } from 'bun:test';
import type { Clock } from '../../src/core/ports.ts';
import { BrowserBaseProvider } from '../../src/providers/browserbase.ts';
import type { ProviderReleaseResult } from '../../src/providers/types.ts';

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('expected value to be defined');
  return v;
}

function mustResult(v: ProviderReleaseResult | void): ProviderReleaseResult {
  if (v === undefined) throw new Error('expected a ProviderReleaseResult, got undefined/void');
  return v;
}

const FAKE_API_KEY = 'bb_test_key_123';
const BASE_URL = 'https://api.browserbase.com';
const PROJECT_ID = 'proj-1';

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-abc-123',
    projectId: PROJECT_ID,
    status: 'RUNNING',
    createdAt: '2026-03-22T11:00:00Z',
    connectUrl: 'wss://connect.browserbase.com/sess-abc-123',
    debugUrl: 'https://debug.browserbase.com/sess-abc-123',
    ...overrides,
  };
}

function fakeClock(startMs = 0): Clock & { advanceOnSleepMs: number } {
  let current = startMs;
  return {
    advanceOnSleepMs: 600,
    now: () => current,
    sleep(ms: number) {
      // Advance faster than the poll interval so tests run instantly while
      // still exercising the "not yet terminal" branch at least once.
      current += this.advanceOnSleepMs > 0 ? this.advanceOnSleepMs : ms;
      return Promise.resolve();
    },
  };
}

describe('BrowserBaseProvider', () => {
  const originalFetch = globalThis.fetch;
  let calls: { url: string; init: RequestInit }[] = [];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    calls = [];
  });

  type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

  function mockFetchSequence(handlers: Handler[]) {
    let i = 0;
    // @ts-expect-error minimal mock
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      const handler = must(handlers[Math.min(i, handlers.length - 1)]);
      i += 1;
      return handler(url, init);
    };
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function textResponse(text: string, status: number): Response {
    return new Response(text, { status });
  }

  // ── createSession ────────────────────────────────────────────────

  describe('createSession', () => {
    test('nests viewport under browserSettings, not top-level', async () => {
      mockFetchSequence([() => jsonResponse(makeSession())]);
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY, projectId: PROJECT_ID });
      await provider.createSession({ width: 1280, height: 720 });

      const body = JSON.parse(must(calls[0]).init.body as string);
      expect(body.browserSettings.viewport).toEqual({ width: 1280, height: 720 });
      expect(body.width).toBeUndefined();
      expect(body.height).toBeUndefined();
    });

    test('preserves native provider options and merges viewport without mutating input', async () => {
      mockFetchSequence([() => jsonResponse(makeSession())]);
      const settings = Object.freeze({
        recordSession: false,
        context: { id: 'saved-context', persist: true },
      });
      const sessionOptions = Object.freeze({
        width: 1280,
        height: 720,
        browserSettings: settings,
        proxies: true,
        userMetadata: { job: 'review' },
        extensionId: 'extension',
      });
      await new BrowserBaseProvider({ apiKey: FAKE_API_KEY, projectId: PROJECT_ID }).createSession(
        sessionOptions
      );
      expect(JSON.parse(must(calls[0]).init.body as string)).toEqual({
        projectId: PROJECT_ID,
        browserSettings: { ...settings, viewport: { width: 1280, height: 720 } },
        proxies: true,
        userMetadata: { job: 'review' },
        extensionId: 'extension',
      });
      expect(settings).not.toHaveProperty('viewport');
    });

    test('maps recording and proxy aliases to Browserbase fields', async () => {
      mockFetchSequence([() => jsonResponse(makeSession())]);
      await new BrowserBaseProvider({ apiKey: FAKE_API_KEY, projectId: PROJECT_ID }).createSession({
        recording: false,
        proxy: { server: 'http://proxy.test:8080', username: 'user', password: 'pass' },
      });
      expect(JSON.parse(must(calls[0]).init.body as string)).toEqual({
        projectId: PROJECT_ID,
        browserSettings: { recordSession: false },
        proxies: [
          {
            type: 'external',
            server: 'http://proxy.test:8080',
            username: 'user',
            password: 'pass',
          },
        ],
      });
    });

    test('invalid options fail before project discovery or session creation', async () => {
      mockFetchSequence([
        () => {
          throw new Error('unexpected request');
        },
      ]);
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY });
      await expect(
        provider.createSession({ proxy: { server: 'http://proxy.test' }, proxies: true })
      ).rejects.toThrow('either proxy or proxies');
      await expect(provider.createSession({ timeout: 1 })).rejects.toThrow('60 to 21600');
      await expect(
        provider.createSession({ browserSettings: { viewport: { width: -1, height: 720 } } })
      ).rejects.toThrow('positive integers');
      expect(calls).toHaveLength(0);
    });

    test.each([
      200, 400,
    ])('request timeout covers a stalled HTTP %i response body', async (status) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let signal: AbortSignal | null | undefined;
      mockFetchSequence([
        (_url, init) => {
          signal = init?.signal;
          return new Response(
            new ReadableStream({
              start(value) {
                controller = value;
              },
            }),
            { status }
          );
        },
      ]);
      const provider = new BrowserBaseProvider({
        apiKey: FAKE_API_KEY,
        projectId: PROJECT_ID,
        requestTimeoutMs: 5,
      });
      try {
        await expect(provider.createSession()).rejects.toThrow('timeout');
        expect(signal?.aborted).toBe(true);
      } finally {
        controller.close();
      }
      expect(calls).toHaveLength(1); // Creation is never retried after uncertain dispatch.
    });

    test('redacts a reflected API key before truncating HTTP and network errors', async () => {
      const body = `${'x'.repeat(290)}${FAKE_API_KEY}`;
      mockFetchSequence([() => textResponse(body, 401)]);
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY, projectId: PROJECT_ID });
      try {
        await provider.createSession();
        throw new Error('expected failure');
      } catch (error) {
        expect(String(error)).toContain('[REDACTED]');
        expect(String(error)).not.toContain(FAKE_API_KEY);
        expect(String(error)).not.toContain('bb_test');
      }
      mockFetchSequence([
        () => {
          throw new Error(`request rejected: ${FAKE_API_KEY}`);
        },
      ]);
      await expect(provider.createSession()).rejects.toThrow('[REDACTED]');
    });

    test('releases an allocated session when connection details cannot be obtained', async () => {
      mockFetchSequence([
        () => jsonResponse(makeSession({ connectUrl: undefined })),
        () => textResponse('unavailable', 503),
        () => jsonResponse({}),
        () => jsonResponse(makeSession({ status: 'COMPLETED' })),
      ]);
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY, projectId: PROJECT_ID });
      await expect(provider.createSession()).rejects.toThrow('cleanup: released');
      expect(must(calls[2]).init.method).toBe('POST');
      expect(JSON.parse(must(calls[2]).init.body as string).status).toBe('REQUEST_RELEASE');
    });

    test('sends X-BB-API-Key header', async () => {
      mockFetchSequence([() => jsonResponse(makeSession())]);
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY, projectId: PROJECT_ID });
      await provider.createSession();

      const headers = must(calls[0]).init.headers as Record<string, string>;
      expect(headers['X-BB-API-Key']).toBe(FAKE_API_KEY);
    });

    test('rejects non-integer / non-positive width or height before any network call', async () => {
      // @ts-expect-error minimal mock — should never be invoked
      globalThis.fetch = async () => {
        throw new Error('fetch should not be called');
      };
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY, projectId: PROJECT_ID });

      await expect(provider.createSession({ width: -1, height: 720 })).rejects.toThrow(
        'positive integer'
      );
      await expect(provider.createSession({ width: 1.5, height: 720 })).rejects.toThrow(
        'positive integer'
      );
      await expect(provider.createSession({ width: 1280 })).rejects.toThrow(
        'must both be provided together'
      );
    });

    test('400 failure includes status and body excerpt, never the API key', async () => {
      mockFetchSequence([() => textResponse('bad request: invalid region xyz', 400)]);
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY, projectId: PROJECT_ID });

      await expect(provider.createSession()).rejects.toThrow('400');
      try {
        await provider.createSession();
        throw new Error('should have thrown');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('400');
        expect(message).toContain('invalid region xyz');
        expect(message).not.toContain(FAKE_API_KEY);
      }
    });

    test('uses connectUrl from create response without extra GET', async () => {
      mockFetchSequence([() => jsonResponse(makeSession())]);
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY, projectId: PROJECT_ID });
      const session = await provider.createSession();

      expect(session.wsUrl).toBe('wss://connect.browserbase.com/sess-abc-123');
      expect(calls.length).toBe(1);
    });

    test('falls back to GET /v1/sessions/:id when connectUrl missing from create response', async () => {
      mockFetchSequence([
        () => jsonResponse(makeSession({ connectUrl: undefined })),
        () => jsonResponse(makeSession({ connectUrl: 'wss://connect.browserbase.com/fallback' })),
      ]);
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY, projectId: PROJECT_ID });
      const session = await provider.createSession();

      expect(session.wsUrl).toBe('wss://connect.browserbase.com/fallback');
      expect(calls.length).toBe(2);
      expect(must(calls[1]).url).toBe(`${BASE_URL}/v1/sessions/sess-abc-123`);
    });

    test('projectId auto-resolution succeeds with exactly one project', async () => {
      mockFetchSequence([
        () => jsonResponse([{ id: 'only-project' }]),
        () => jsonResponse(makeSession({ projectId: 'only-project' })),
      ]);
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY });
      const session = await provider.createSession();

      expect(session.metadata?.['projectId']).toBe('only-project');
      const firstBody = JSON.parse(must(calls[1]).init.body as string);
      expect(firstBody.projectId).toBe('only-project');
    });

    test('projectId auto-resolution errors on multiple projects', async () => {
      mockFetchSequence([() => jsonResponse([{ id: 'p1' }, { id: 'p2' }])]);
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY });

      await expect(provider.createSession()).rejects.toThrow('found 2 projects');
    });

    test('projectId auto-resolution errors on zero projects', async () => {
      mockFetchSequence([() => jsonResponse([])]);
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY });

      await expect(provider.createSession()).rejects.toThrow('no projects found');
    });

    test('recovers from a failed project resolution on a later createSession call', async () => {
      let call = 0;
      // @ts-expect-error minimal mock
      globalThis.fetch = async (url: string, init?: RequestInit) => {
        calls.push({ url, init: init ?? {} });
        call += 1;
        if (call === 1) throw new Error('ECONNRESET');
        if (call === 2) return jsonResponse([{ id: 'only-project' }]);
        return jsonResponse(makeSession({ projectId: 'only-project' }));
      };
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY });

      await expect(provider.createSession()).rejects.toThrow('network error');

      const session = await provider.createSession();
      expect(session.metadata?.['projectId']).toBe('only-project');
      expect(calls.length).toBe(3);
    });

    test('request timeout aborts the fetch', async () => {
      // @ts-expect-error minimal mock
      globalThis.fetch = async (_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
        });
      };
      const provider = new BrowserBaseProvider({
        apiKey: FAKE_API_KEY,
        projectId: PROJECT_ID,
        requestTimeoutMs: 5,
      });

      await expect(provider.createSession()).rejects.toThrow('network error');
    });
  });

  // ── close / release ─────────────────────────────────────────────

  describe('close', () => {
    test('sends POST (not DELETE) with REQUEST_RELEASE status', async () => {
      mockFetchSequence([
        () => jsonResponse(makeSession()),
        () => jsonResponse(makeSession({ status: 'COMPLETED' })),
      ]);
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY, projectId: PROJECT_ID });
      const session = await provider.createSession();

      const result = await session.close();

      const releaseCall = must(calls[1]);
      expect(releaseCall.init.method).toBe('POST');
      const body = JSON.parse(releaseCall.init.body as string);
      expect(body.status).toBe('REQUEST_RELEASE');
      expect(body.projectId).toBe(PROJECT_ID);
      expect(result).toEqual({
        status: 'released',
        sessionId: 'sess-abc-123',
        providerStatus: 'COMPLETED',
      });
    });

    test('404 on release → already_released', async () => {
      mockFetchSequence([() => jsonResponse(makeSession()), () => textResponse('not found', 404)]);
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY, projectId: PROJECT_ID });
      const session = await provider.createSession();

      const result = await session.close();
      expect(result).toEqual({ status: 'already_released', sessionId: 'sess-abc-123' });
    });

    test('release then poll to COMPLETED → released', async () => {
      mockFetchSequence([
        () => jsonResponse(makeSession()),
        () => jsonResponse({}), // POST release ack
        () => jsonResponse(makeSession({ status: 'RUNNING' })), // poll 1: not yet terminal
        () => jsonResponse(makeSession({ status: 'COMPLETED' })), // poll 2: terminal
      ]);
      const clock = fakeClock();
      const provider = new BrowserBaseProvider({
        apiKey: FAKE_API_KEY,
        projectId: PROJECT_ID,
        clock,
      });
      const session = await provider.createSession();

      const result = await session.close();
      expect(result).toEqual({
        status: 'released',
        sessionId: 'sess-abc-123',
        providerStatus: 'COMPLETED',
      });
    });

    test('poll never reaches terminal state → cleanup_pending within deadline', async () => {
      mockFetchSequence([
        () => jsonResponse(makeSession()),
        () => jsonResponse({}), // POST release ack
        () => jsonResponse(makeSession({ status: 'RUNNING' })), // always running
      ]);
      const clock = fakeClock();
      clock.advanceOnSleepMs = 20_000; // jump straight past the deadline on first sleep
      const provider = new BrowserBaseProvider({
        apiKey: FAKE_API_KEY,
        projectId: PROJECT_ID,
        releaseTimeoutMs: 10_000,
        clock,
      });
      const session = await provider.createSession();

      const result = mustResult(await session.close());
      expect(result.status).toBe('cleanup_pending');
      expect(result.sessionId).toBe('sess-abc-123');
    });

    test('network failure during release → cleanup_pending, does not throw', async () => {
      let call = 0;
      // @ts-expect-error minimal mock
      globalThis.fetch = async (url: string, init?: RequestInit) => {
        calls.push({ url, init: init ?? {} });
        call += 1;
        if (call === 1) return jsonResponse(makeSession());
        throw new Error('ECONNRESET');
      };
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY, projectId: PROJECT_ID });
      const session = await provider.createSession();

      const result = mustResult(await session.close());
      expect(result.status).toBe('cleanup_pending');
      expect(result.error).toContain('ECONNRESET');
    });

    test('repeated close() returns the same result without extra requests', async () => {
      mockFetchSequence([() => jsonResponse(makeSession()), () => textResponse('gone', 410)]);
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY, projectId: PROJECT_ID });
      const session = await provider.createSession();

      const first = await session.close();
      const callCountAfterFirst = calls.length;
      const second = await session.close();

      expect(second).toEqual(first);
      expect(calls.length).toBe(callCountAfterFirst);
    });

    test('cleanup_pending is not cached: a later close() retries and can reach released', async () => {
      mockFetchSequence([
        () => jsonResponse(makeSession()),
        () => jsonResponse({}), // POST release ack (1st close)
        () => jsonResponse(makeSession({ status: 'RUNNING' })), // poll: never terminal within deadline
        () => jsonResponse({}), // POST release ack (2nd close)
        () => jsonResponse(makeSession({ status: 'COMPLETED' })), // poll: terminal
      ]);
      const clock = fakeClock();
      clock.advanceOnSleepMs = 20_000; // jump straight past the deadline on first sleep
      const provider = new BrowserBaseProvider({
        apiKey: FAKE_API_KEY,
        projectId: PROJECT_ID,
        releaseTimeoutMs: 10_000,
        clock,
      });
      const session = await provider.createSession();

      const first = mustResult(await session.close());
      expect(first.status).toBe('cleanup_pending');

      const second = mustResult(await session.close());
      expect(second).toEqual({
        status: 'released',
        sessionId: 'sess-abc-123',
        providerStatus: 'COMPLETED',
      });
    });

    test('malformed polling JSON returns cleanup_pending and allows a later retry', async () => {
      mockFetchSequence([
        () => jsonResponse(makeSession()),
        () => jsonResponse({}),
        () => textResponse('broken-json', 200),
        () => jsonResponse({}),
        () => jsonResponse(makeSession({ status: 'COMPLETED' })),
      ]);
      const session = await new BrowserBaseProvider({
        apiKey: FAKE_API_KEY,
        projectId: PROJECT_ID,
      }).createSession();
      const first = mustResult(await session.close());
      expect(first.status).toBe('cleanup_pending');
      expect(first.error).toContain('invalid JSON');
      expect((await session.close())?.status).toBe('released');
      expect(calls).toHaveLength(5);
    });

    test('concurrent closes share one release attempt', async () => {
      mockFetchSequence([
        () => jsonResponse(makeSession()),
        () => jsonResponse({}),
        () => jsonResponse(makeSession({ status: 'COMPLETED' })),
      ]);
      const session = await new BrowserBaseProvider({
        apiKey: FAKE_API_KEY,
        projectId: PROJECT_ID,
      }).createSession();
      const results = await Promise.all([session.close(), session.close()]);
      expect(results[0]).toEqual(results[1]);
      expect(results[0]?.status).toBe('released');
      expect(calls).toHaveLength(3);
    });

    test('release deadline includes POST and refuses a late successful response', async () => {
      const clock = fakeClock();
      clock.advanceOnSleepMs = 10;
      mockFetchSequence([
        () => jsonResponse(makeSession()),
        async () => {
          await clock.sleep(10);
          return jsonResponse(makeSession({ status: 'COMPLETED' }));
        },
      ]);
      const session = await new BrowserBaseProvider({
        apiKey: FAKE_API_KEY,
        projectId: PROJECT_ID,
        releaseTimeoutMs: 10,
        clock,
      }).createSession();
      expect((await session.close())?.status).toBe('cleanup_pending');
      expect(calls).toHaveLength(2);
    });

    test('poll sleep uses remaining budget and no request starts after expiry', async () => {
      let time = 0;
      const sleeps: number[] = [];
      mockFetchSequence([
        () => jsonResponse(makeSession()),
        () => jsonResponse({}),
        () => jsonResponse(makeSession()),
      ]);
      const session = await new BrowserBaseProvider({
        apiKey: FAKE_API_KEY,
        projectId: PROJECT_ID,
        releaseTimeoutMs: 25,
        clock: {
          now: () => time,
          sleep: async (ms) => {
            sleeps.push(ms);
            time += ms;
          },
        },
      }).createSession();
      expect(await session.close()).toEqual({
        status: 'cleanup_pending',
        sessionId: 'sess-abc-123',
        providerStatus: 'RUNNING',
      });
      expect(sleeps).toEqual([25]);
      expect(calls).toHaveLength(3);
    });

    test('a stalled polling body is bounded by remaining cleanup time', async () => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let signal: AbortSignal | null | undefined;
      mockFetchSequence([
        () => jsonResponse(makeSession()),
        () => jsonResponse({}),
        (_url, init) => {
          signal = init?.signal;
          return new Response(
            new ReadableStream({
              start(value) {
                controller = value;
              },
            })
          );
        },
      ]);
      const session = await new BrowserBaseProvider({
        apiKey: FAKE_API_KEY,
        projectId: PROJECT_ID,
        requestTimeoutMs: 10_000,
        releaseTimeoutMs: 10,
      }).createSession();
      try {
        const result = mustResult(await session.close());
        expect(result.status).toBe('cleanup_pending');
        expect(result.error).toContain('timeout');
        expect(signal?.aborted).toBe(true);
      } finally {
        controller.close();
      }
    });
  });

  // ── resumeSession ────────────────────────────────────────────────

  describe('resumeSession', () => {
    test('happy path resolves wsUrl from RUNNING session', async () => {
      mockFetchSequence([() => jsonResponse(makeSession())]);
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY, projectId: PROJECT_ID });
      const session = await provider.resumeSession('sess-abc-123');

      expect(session.wsUrl).toBe('wss://connect.browserbase.com/sess-abc-123');
      expect(session.sessionId).toBe('sess-abc-123');
    });

    test('uses each resumed session project for release without listing projects', async () => {
      mockFetchSequence([
        () => jsonResponse(makeSession({ id: 'session-a', projectId: 'project-a' })),
        () => jsonResponse(makeSession({ id: 'session-b', projectId: 'project-b' })),
        () => textResponse('gone', 410),
        () => textResponse('gone', 410),
      ]);
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY });
      const a = await provider.resumeSession('session-a');
      const b = await provider.resumeSession('session-b');
      await a.close();
      await b.close();
      expect(calls.some((call) => call.url.endsWith('/projects'))).toBe(false);
      expect(JSON.parse(must(calls[2]).init.body as string).projectId).toBe('project-a');
      expect(JSON.parse(must(calls[3]).init.body as string).projectId).toBe('project-b');
    });

    test('errors when session is closed / not RUNNING', async () => {
      mockFetchSequence([
        () => jsonResponse(makeSession({ status: 'COMPLETED', connectUrl: undefined })),
      ]);
      const provider = new BrowserBaseProvider({ apiKey: FAKE_API_KEY, projectId: PROJECT_ID });

      await expect(provider.resumeSession('sess-abc-123')).rejects.toThrow(
        'not active or does not have a connectUrl'
      );
    });
  });
});
