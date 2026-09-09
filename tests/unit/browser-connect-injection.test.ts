/**
 * Unit tests for injected providerSession / resumeSession wiring in
 * Browser.connect() and the close()/disconnect() release contract.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Browser } from '../../src/browser/browser.ts';
import { Browser as RootBrowser } from '../../src/browser/index.ts';
import type { CDPClient } from '../../src/cdp/client.ts';
import type { CreateSessionOptions, ProviderSession } from '../../src/providers/types.ts';

function makeFakeCDP(overrides: Partial<CDPClient> = {}): CDPClient {
  return {
    send: mock(async () => ({})),
    on: mock(() => {}),
    off: mock(() => {}),
    onSessionEvent: mock(() => () => {}),
    onAny: mock(() => {}),
    offAny: mock(() => {}),
    onTargetAttached: mock(() => () => {}),
    close: mock(async () => {}),
    attachToTarget: mock(async () => 'session-1'),
    setAutoAttach: mock(async () => {}),
    runIfWaitingForDebugger: mock(async () => {}),
    sessions: new Set<string>(),
    hasSession: mock(() => false),
    sessionId: undefined,
    setSessionId: mock(() => {}),
    isConnected: true,
    ...overrides,
  } as CDPClient;
}

const RealWebSocket = globalThis.WebSocket;
const RealFetch = globalThis.fetch;

type Listener = (event?: { data?: string }) => void;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  private listeners = new Map<string, Set<Listener>>();

  constructor(_url: string) {
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.emit('open');
    });
  }

  addEventListener(type: string, handler: Listener) {
    let handlers = this.listeners.get(type);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(type, handlers);
    }
    handlers.add(handler);
  }

  removeEventListener(type: string, handler: Listener) {
    this.listeners.get(type)?.delete(handler);
  }

  send(message: string) {
    // Reply to Target.setDiscoverTargets (issued during Browser construction)
    // so `targetDiscoveryReady` resolves.
    const parsed = JSON.parse(message) as { id: number; method: string };
    if (parsed.method === 'Target.setDiscoverTargets') {
      queueMicrotask(() => {
        this.emit('message', { data: JSON.stringify({ id: parsed.id, result: {} }) });
      });
    }
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    queueMicrotask(() => this.emit('close'));
  }

  private emit(type: string, event?: { data?: string }) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }
}

describe('Browser.connect() provider session wiring', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { WebSocket: typeof WebSocket }).WebSocket =
      MockWebSocket as unknown as typeof WebSocket;
    // Fail loudly if anything tries to reach a real provider API.
    globalThis.fetch = mock(() => {
      throw new Error('fetch should not be called for an injected providerSession');
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    (globalThis as typeof globalThis & { WebSocket: typeof WebSocket }).WebSocket = RealWebSocket;
    globalThis.fetch = RealFetch;
  });

  test('injected providerSession skips provider/session creation entirely', async () => {
    const closeMock = mock(async () => ({
      status: 'released' as const,
      sessionId: 'injected-session',
    }));
    const providerSession: ProviderSession = {
      wsUrl: 'ws://example.test/injected',
      close: closeMock,
    };

    const browser = await Browser.connect({
      provider: 'generic',
      providerSession,
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();

    const result = await browser.close();
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'released', sessionId: 'injected-session' });
  });

  test('releases an injected session if opening the socket fails', async () => {
    globalThis.WebSocket = class {
      constructor() {
        throw new Error('socket refused');
      }
    } as unknown as typeof WebSocket;
    const close = mock(async () => undefined);
    await expect(
      Browser.connect({
        provider: 'generic',
        providerSession: { wsUrl: 'wss://example.test', close },
      })
    ).rejects.toThrow('socket refused');
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('reports cleanup_pending when an injected connection cannot be opened', async () => {
    globalThis.WebSocket = class {
      constructor() {
        throw new Error('socket refused');
      }
    } as unknown as typeof WebSocket;
    await expect(
      Browser.connect({
        provider: 'generic',
        providerSession: {
          wsUrl: 'wss://example.test',
          close: async () => ({ status: 'cleanup_pending', sessionId: 'needs-cleanup' }),
        },
      })
    ).rejects.toThrow('provider cleanup pending for session needs-cleanup');
  });

  test('a failed resume does not release the existing provider session', async () => {
    globalThis.WebSocket = class {
      constructor() {
        throw new Error('socket refused');
      }
    } as unknown as typeof WebSocket;
    const fetchMock = mock(async () =>
      Response.json({
        id: 'existing-session',
        projectId: 'existing-project',
        status: 'RUNNING',
        connectUrl: 'wss://example.test',
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      Browser.connect({
        provider: 'browserbase',
        apiKey: 'fake-key',
        session: { sessionId: 'existing-session' },
      })
    ).rejects.toThrow('socket refused');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('disconnect() does not close the injected providerSession', async () => {
    const closeMock = mock(async () => undefined);
    const providerSession: ProviderSession = {
      wsUrl: 'ws://example.test/injected',
      close: closeMock,
    };

    const browser = await Browser.connect({
      provider: 'generic',
      providerSession,
    });

    await browser.disconnect();
    expect(closeMock).not.toHaveBeenCalled();
  });

  test('session.sessionId triggers resumeSession instead of createSession', async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        throw new Error('createSession (POST) should not be called when resuming');
      }
      // resumeSession GET /browsers/:id
      return new Response(
        JSON.stringify({
          id: 'existing-session-id',
          status: 'active',
          cdpUrl: 'ws://example.test/resumed',
          liveUrl: null,
          timeoutAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const browser = await Browser.connect({
      provider: 'browser-use',
      apiKey: 'test-api-key',
      session: { sessionId: 'existing-session-id' } as CreateSessionOptions,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/browsers/existing-session-id');
    expect(init?.method ?? 'GET').toBe('GET');

    await browser.disconnect();
  });

  test('close() still releases the provider session when cdp.close() rejects', async () => {
    const closeMock = mock(async () => ({
      status: 'released' as const,
      sessionId: 'fromcdp-session',
    }));
    const providerSession: ProviderSession = {
      wsUrl: 'ws://example.test/fromcdp',
      sessionId: 'fromcdp-session',
      close: closeMock,
    };
    const fakeCdp = makeFakeCDP({
      close: mock(async () => {
        throw new Error('cdp close boom');
      }),
    });

    const browser = Browser.fromCDP(fakeCdp, {
      wsUrl: providerSession.wsUrl,
      sessionId: providerSession.sessionId,
    });
    // fromCDP wires its own no-op providerSession; swap in our spy so we can
    // observe that it still runs even when cdp.close() rejects.
    (browser as unknown as { providerSession: ProviderSession }).providerSession = providerSession;

    const result = await browser.close();
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(result?.status).toBe('released');
    expect(result?.sessionId).toBe('fromcdp-session');
    expect(result?.error).toContain('cdp close boom');
  });

  test('root Browser.fromCDP keeps root instanceof behavior', async () => {
    const fakeCdp = makeFakeCDP();
    const browser = RootBrowser.fromCDP(fakeCdp, { wsUrl: 'ws://example.test/root' });

    expect(browser).toBeInstanceOf(RootBrowser);
    expect(browser).toBeInstanceOf(Browser);
    await browser.disconnect();
  });

  test('importing the root entry does not install defaults on portable Browser', async () => {
    await expect(Browser.connect({ provider: 'generic' })).rejects.toMatchObject({
      name: 'CapabilityError',
      capability: 'local-discovery',
    });
  });
});
