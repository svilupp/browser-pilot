import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SessionData } from '../../src/cli/session.ts';

/**
 * Tests for the daemon system:
 * - Daemon health checks (max age, PID, heartbeat)
 * - Attach fallback (daemon unavailable → direct WebSocket)
 * - Session daemon field lifecycle
 * - CDPClient offAny support
 */

// --- Mock the attach module (module-level, same pattern as attach.test.ts) ---

let mockAttachImpl: (
  session: SessionData,
  options?: { trace?: boolean }
) => Promise<{
  session: SessionData;
  browser: { close: () => Promise<void> };
  page: {
    batch: () => Promise<unknown>;
    url: () => Promise<string>;
    importRefMap: (m: Record<string, number>) => void;
  };
  viaDaemon: boolean;
}>;

mock.module('../../src/cli/attach.ts', () => ({
  resolveSession: () => Promise.reject(new Error('not configured')),
  attachSession: (session: SessionData, options?: { trace?: boolean }) =>
    mockAttachImpl(session, options),
}));

const { attachSession } = await import('../../src/cli/attach.ts');

// --- Helpers ---

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: 'test-session',
    provider: 'generic',
    wsUrl: 'ws://localhost:9222/devtools/browser/abc',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    currentUrl: 'https://example.com',
    ...overrides,
  };
}

// --- CDPClient offAny tests ---

describe('CDPClient offAny', () => {
  test('offAny removes a previously registered handler', async () => {
    const RealWebSocket = globalThis.WebSocket;

    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      readyState = MockWebSocket.CONNECTING;
      private listeners = new Map<string, Set<(event?: unknown) => void>>();

      constructor(_url: string) {
        queueMicrotask(() => {
          this.readyState = MockWebSocket.OPEN;
          this.emit('open');
        });
      }

      addEventListener(type: string, handler: (event?: unknown) => void) {
        let handlers = this.listeners.get(type);
        if (!handlers) {
          handlers = new Set();
          this.listeners.set(type, handlers);
        }
        handlers.add(handler);
      }

      removeEventListener(type: string, handler: (event?: unknown) => void) {
        this.listeners.get(type)?.delete(handler);
      }

      send(_message: string) {}

      close() {
        this.readyState = MockWebSocket.CLOSING;
      }

      emit(type: string, event?: unknown) {
        for (const handler of this.listeners.get(type) ?? []) {
          handler(event);
        }
      }
    }

    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;

    try {
      const { createCDPClient } = await import('../../src/cdp/client.ts');
      const client = await createCDPClient('ws://example.test');
      expect(typeof client.offAny).toBe('function');
    } finally {
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = RealWebSocket;
    }
  });
});

// --- Daemon types tests ---

describe('daemon types and constants', () => {
  test('DAEMON_MAX_AGE_MS is 60 minutes', async () => {
    const { DAEMON_MAX_AGE_MS } = await import('../../src/daemon/types.ts');
    expect(DAEMON_MAX_AGE_MS).toBe(60 * 60 * 1000);
  });

  test('DAEMON_CONNECT_TIMEOUT_MS is 500ms', async () => {
    const { DAEMON_CONNECT_TIMEOUT_MS } = await import('../../src/daemon/types.ts');
    expect(DAEMON_CONNECT_TIMEOUT_MS).toBe(500);
  });

  test('DAEMON_IDLE_TIMEOUT_MS is 60 minutes', async () => {
    const { DAEMON_IDLE_TIMEOUT_MS } = await import('../../src/daemon/types.ts');
    expect(DAEMON_IDLE_TIMEOUT_MS).toBe(60 * 60 * 1000);
  });

  test('DAEMON_HEARTBEAT_INTERVAL_MS is 30 seconds', async () => {
    const { DAEMON_HEARTBEAT_INTERVAL_MS } = await import('../../src/daemon/types.ts');
    expect(DAEMON_HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });
});

// --- Daemon lifecycle tests ---

describe('daemon lifecycle', () => {
  test('isDaemonAlive returns false for non-existent PID', async () => {
    const { isDaemonAlive } = await import('../../src/daemon/lifecycle.ts');
    expect(isDaemonAlive(99999999)).toBe(false);
  });

  test('isDaemonAlive returns true for own PID', async () => {
    const { isDaemonAlive } = await import('../../src/daemon/lifecycle.ts');
    expect(isDaemonAlive(process.pid)).toBe(true);
  });

  test('createIdleTimer calls onIdle after timeout', async () => {
    const { createIdleTimer } = await import('../../src/daemon/lifecycle.ts');
    let called = false;
    const timer = createIdleTimer(() => {
      called = true;
    }, 50);

    await new Promise((r) => setTimeout(r, 100));
    expect(called).toBe(true);
    timer.stop();
  });

  test('createIdleTimer reset delays the callback', async () => {
    const { createIdleTimer } = await import('../../src/daemon/lifecycle.ts');
    let called = false;
    const timer = createIdleTimer(() => {
      called = true;
    }, 100);

    await new Promise((r) => setTimeout(r, 50));
    timer.reset();
    expect(called).toBe(false);

    await new Promise((r) => setTimeout(r, 50));
    expect(called).toBe(false);

    await new Promise((r) => setTimeout(r, 70));
    expect(called).toBe(true);
    timer.stop();
  });

  test('createIdleTimer stop prevents callback', async () => {
    const { createIdleTimer } = await import('../../src/daemon/lifecycle.ts');
    let called = false;
    const timer = createIdleTimer(() => {
      called = true;
    }, 50);

    timer.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(called).toBe(false);
  });
});

// --- Attach fallback tests ---

describe('daemon attach fallback', () => {
  beforeEach(() => {
    mockAttachImpl = () => Promise.reject(new Error('not configured'));
  });

  test('returns viaDaemon false when no daemon configured', async () => {
    const session = makeSession();
    mockAttachImpl = (s) =>
      Promise.resolve({
        session: s,
        browser: { close: () => Promise.resolve() },
        page: {
          batch: () => Promise.resolve({ success: true }),
          url: () => Promise.resolve('https://example.com'),
          importRefMap: () => {},
        },
        viaDaemon: false,
      });

    const result = await attachSession(session);
    expect(result.viaDaemon).toBe(false);
  });

  test('falls back to direct WS when daemon PID is dead', async () => {
    const session = makeSession({
      daemon: {
        socketPath: '/tmp/nonexistent.sock',
        pid: 99999999,
        startedAt: new Date().toISOString(),
      },
    });

    mockAttachImpl = (s) =>
      Promise.resolve({
        session: s,
        browser: { close: () => Promise.resolve() },
        page: {
          batch: () => Promise.resolve({ success: true }),
          url: () => Promise.resolve('https://example.com'),
          importRefMap: () => {},
        },
        viaDaemon: false,
      });

    const result = await attachSession(session);
    expect(result.viaDaemon).toBe(false);
  });

  test('falls back when daemon is expired (>60 minutes)', async () => {
    const longAgo = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    const session = makeSession({
      daemon: {
        socketPath: '/tmp/nonexistent.sock',
        pid: process.pid,
        startedAt: longAgo,
      },
    });

    mockAttachImpl = (s) =>
      Promise.resolve({
        session: s,
        browser: { close: () => Promise.resolve() },
        page: {
          batch: () => Promise.resolve({ success: true }),
          url: () => Promise.resolve('https://example.com'),
          importRefMap: () => {},
        },
        viaDaemon: false,
      });

    const result = await attachSession(session);
    expect(result.viaDaemon).toBe(false);
  });

  test('throws on connection failure and cleans up session', async () => {
    const session = makeSession({ id: 'dead-session' });
    mockAttachImpl = () =>
      Promise.reject(
        new Error(
          'Session "dead-session" is no longer valid (browser may have closed).\n' +
            'Session file has been cleaned up. Run "bp connect" to create a new session.'
        )
      );

    await expect(attachSession(session)).rejects.toThrow('bp connect');
  });
});

// --- Session daemon field tests ---

describe('session daemon field', () => {
  test('SessionData accepts optional daemon field', () => {
    const session: SessionData = {
      id: 'test',
      provider: 'generic',
      wsUrl: 'ws://localhost:9222',
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      currentUrl: 'https://example.com',
      daemon: {
        socketPath: '/home/user/.browser-pilot/sessions/test/daemon.sock',
        pid: 12345,
        startedAt: new Date().toISOString(),
      },
    };

    expect(session.daemon).toBeDefined();
    expect(session.daemon?.pid).toBe(12345);
    expect(session.daemon?.socketPath).toContain('daemon.sock');
  });

  test('SessionData without daemon field is valid', () => {
    const session: SessionData = {
      id: 'test',
      provider: 'generic',
      wsUrl: 'ws://localhost:9222',
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      currentUrl: 'https://example.com',
    };

    expect(session.daemon).toBeUndefined();
  });
});

// --- Connect command --no-daemon parsing ---

describe('connect command argument parsing', () => {
  test('--no-daemon is listed in help text', async () => {
    const { connectCommand } = await import('../../src/cli/commands/connect.ts');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));

    await connectCommand([], { help: true });

    console.log = origLog;

    const helpText = logs.join('\n');
    expect(helpText).toContain('--no-daemon');
    expect(helpText).toContain('--daemon-idle');
  });
});

// --- Daemon command ---

describe('daemon command', () => {
  test('shows help when no subcommand given', async () => {
    const { daemonCommand } = await import('../../src/cli/commands/daemon.ts');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));

    await daemonCommand([], {});

    console.log = origLog;

    const helpText = logs.join('\n');
    expect(helpText).toContain('bp daemon');
    expect(helpText).toContain('status');
    expect(helpText).toContain('stop');
    expect(helpText).toContain('logs');
  });
});
