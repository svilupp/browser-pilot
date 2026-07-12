import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CDPClient } from '../../src/cdp/client.ts';
import { createCDPClientFromTransport } from '../../src/cdp/client.ts';
import { startDaemonServer } from '../../src/daemon/server.ts';
import { createDaemonTransport } from '../../src/daemon/transport.ts';

/**
 * Tests for daemon session-aware event forwarding and the paused-child safety net.
 *
 * Uses a real Unix socket server backed by a fake CDPClient so we can drive
 * `onAny` / `onTargetAttached` emissions deterministically and observe both the
 * raw forwarded JSON and the fully-parsed CLI-side CDP client behavior.
 */

type AnyHandler = (method: string, params: Record<string, unknown>, sessionId?: string) => void;
type TargetAttachedHandler = (info: {
  sessionId: string;
  targetInfo: unknown;
  waitingForDebugger: boolean;
}) => void;

interface FakeCDP {
  client: CDPClient;
  emitEvent: (method: string, params: Record<string, unknown>, sessionId?: string) => void;
  emitAttached: (sessionId: string, waitingForDebugger: boolean) => void;
  unpaused: string[];
  liveSessions: Set<string>;
}

function makeFakeCDP(): FakeCDP {
  const anyHandlers = new Set<AnyHandler>();
  const attachedHandlers = new Set<TargetAttachedHandler>();
  const unpaused: string[] = [];
  const liveSessions = new Set<string>();

  const client = {
    send: () => Promise.resolve({}),
    on: () => {},
    off: () => {},
    onSessionEvent: () => () => {},
    onAny: (handler: AnyHandler) => {
      anyHandlers.add(handler);
    },
    offAny: (handler: AnyHandler) => {
      anyHandlers.delete(handler);
    },
    onTargetAttached: (handler: TargetAttachedHandler) => {
      attachedHandlers.add(handler);
      return () => attachedHandlers.delete(handler);
    },
    runIfWaitingForDebugger: (sessionId: string) => {
      unpaused.push(sessionId);
      return Promise.resolve();
    },
    setAutoAttach: () => Promise.resolve(),
    close: () => Promise.resolve(),
    attachToTarget: () => Promise.resolve('sess'),
    sessions: liveSessions as ReadonlySet<string>,
    hasSession: (sessionId: string) => liveSessions.has(sessionId),
    sessionId: undefined,
    setSessionId: () => {},
    isConnected: true,
  } as unknown as CDPClient;

  return {
    client,
    emitEvent: (method, params, sessionId) => {
      for (const h of anyHandlers) h(method, params, sessionId);
    },
    emitAttached: (sessionId, waitingForDebugger) => {
      liveSessions.add(sessionId);
      for (const h of attachedHandlers) {
        h({ sessionId, targetInfo: {}, waitingForDebugger });
      }
    },
    unpaused,
    liveSessions,
  };
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) {
    await c();
  }
});

function makeSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bp-daemon-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'daemon.sock');
}

describe('daemon event forwarding carries sessionId', () => {
  test('forwarded event JSON includes the originating sessionId', async () => {
    const fake = makeFakeCDP();
    const socketPath = makeSocketPath();
    const server = await startDaemonServer(socketPath, fake.client, () => {});
    cleanups.push(() => server.close());

    // Raw client socket that just records lines it receives.
    const transport = await createDaemonTransport(socketPath, { timeout: 1000 });
    cleanups.push(() => transport.close());

    const lines: string[] = [];
    transport.onMessage((line) => lines.push(line));

    fake.emitEvent('Runtime.consoleAPICalled', { type: 'log' }, 'CHILD_SESSION_1');
    await new Promise((r) => setTimeout(r, 50));

    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.method).toBe('Runtime.consoleAPICalled');
    expect(parsed.sessionId).toBe('CHILD_SESSION_1');
  });

  test('sessionId routes to onSessionEvent on the CLI-side CDP client', async () => {
    const fake = makeFakeCDP();
    const socketPath = makeSocketPath();
    const server = await startDaemonServer(socketPath, fake.client, () => {});
    cleanups.push(() => server.close());

    const transport = await createDaemonTransport(socketPath, { timeout: 1000 });
    const cliClient = await createCDPClientFromTransport(transport);
    cleanups.push(() => cliClient.close());

    const childEvents: Array<Record<string, unknown>> = [];
    cliClient.onSessionEvent('CHILD_SESSION_1', 'Network.requestWillBeSent', (params) => {
      childEvents.push(params);
    });

    // Event for a different session must NOT leak into the child handler.
    fake.emitEvent('Network.requestWillBeSent', { requestId: 'other' }, 'OTHER_SESSION');
    // Event for the subscribed child session should arrive.
    fake.emitEvent('Network.requestWillBeSent', { requestId: 'child' }, 'CHILD_SESSION_1');
    await new Promise((r) => setTimeout(r, 50));

    expect(childEvents.length).toBe(1);
    expect(childEvents[0]!['requestId']).toBe('child');
  });
});

describe('daemon paused-child safety net', () => {
  test('unpauses a waiting target immediately when no client is connected', async () => {
    const fake = makeFakeCDP();
    const socketPath = makeSocketPath();
    const server = await startDaemonServer(socketPath, fake.client, () => {});
    cleanups.push(() => server.close());

    fake.emitAttached('WAITING_CHILD', true);
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.unpaused).toContain('WAITING_CHILD');
  });

  test('does not unpause a child that is not waiting for the debugger', async () => {
    const fake = makeFakeCDP();
    const socketPath = makeSocketPath();
    const server = await startDaemonServer(socketPath, fake.client, () => {});
    cleanups.push(() => server.close());

    fake.emitAttached('RUNNING_CHILD', false);
    await new Promise((r) => setTimeout(r, 20));

    expect(fake.unpaused).not.toContain('RUNNING_CHILD');
  });

  test('defers to a connected client but falls back if it never unpauses', async () => {
    const fake = makeFakeCDP();
    const socketPath = makeSocketPath();
    const server = await startDaemonServer(socketPath, fake.client, () => {});
    cleanups.push(() => server.close());

    const transport = await createDaemonTransport(socketPath, { timeout: 1000 });
    cleanups.push(() => transport.close());
    // Give the server a moment to register the connection.
    await new Promise((r) => setTimeout(r, 20));

    fake.emitAttached('WAITING_CHILD', true);

    // A client is connected, so no immediate unpause.
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.unpaused).not.toContain('WAITING_CHILD');

    // Fallback timer (2s) unpauses since the child is still attached.
    await new Promise((r) => setTimeout(r, 2100));
    expect(fake.unpaused).toContain('WAITING_CHILD');
  }, 5000);

  test('server close clears a pending fallback timer (no post-close unpause)', async () => {
    const fake = makeFakeCDP();
    const socketPath = makeSocketPath();
    const server = await startDaemonServer(socketPath, fake.client, () => {});

    const transport = await createDaemonTransport(socketPath, { timeout: 1000 });
    cleanups.push(() => transport.close());
    await new Promise((r) => setTimeout(r, 20));

    // Child attaches while a client is connected → arms the 2s fallback timer.
    fake.emitAttached('LATE_CHILD', true);
    // Shut down before the fallback fires.
    await server.close();

    await new Promise((r) => setTimeout(r, 2200));
    expect(fake.unpaused).not.toContain('LATE_CHILD');
  }, 5000);
});
