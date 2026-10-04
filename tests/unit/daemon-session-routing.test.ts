import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CDPClient } from '../../src/cdp/client.ts';
import { createCDPClientFromTransport } from '../../src/cdp/client.ts';
import { RuntimeResultError } from '../../src/cdp/runtime-result.ts';
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

describe('daemon IPC budgets', () => {
  test('remaining budget reaches CDP options and private fields stay outside params', async () => {
    const fake = makeFakeCDP();
    const seen: unknown[][] = [];
    fake.client.send = async (...args: Parameters<CDPClient['send']>) => {
      seen.push(args);
      return {} as never;
    };
    const socketPath = makeSocketPath();
    const server = await startDaemonServer(socketPath, fake.client, () => {});
    cleanups.push(() => server.close());
    const transport = await createDaemonTransport(socketPath, { timeout: 1000 });
    cleanups.push(() => transport.close());
    const received = new Promise<string>((resolve) => transport.onMessage(resolve));
    transport.send(
      JSON.stringify({
        id: 1,
        method: 'Page.navigate',
        params: { url: 'https://fixture.test' },
        ipcBudget: { timeoutMs: 500, sentAt: Date.now() - 200 },
      })
    );
    await received;
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[1]).toEqual({ url: 'https://fixture.test' });
    expect((seen[0]?.[3] as { timeout: number }).timeout).toBeLessThanOrEqual(300);
    expect((seen[0]?.[3] as { timeout: number }).timeout).toBeGreaterThan(0);
  });

  test('expired IPC request never dispatches to the browser', async () => {
    const fake = makeFakeCDP();
    let calls = 0;
    fake.client.send = async () => {
      calls++;
      return {} as never;
    };
    const socketPath = makeSocketPath();
    const server = await startDaemonServer(socketPath, fake.client, () => {});
    cleanups.push(() => server.close());
    const transport = await createDaemonTransport(socketPath, { timeout: 1000 });
    cleanups.push(() => transport.close());
    const received = new Promise<string>((resolve) => transport.onMessage(resolve));
    transport.send(
      JSON.stringify({
        id: 1,
        method: 'Input.insertText',
        params: { text: 'example' },
        ipcBudget: { timeoutMs: 10, sentAt: Date.now() - 100 },
      })
    );
    expect(JSON.parse(await received).error.message).toContain('before browser dispatch');
    expect(calls).toBe(0);
  });
  test('hosted command leases reject contenders before dispatch and detach preserves the owner', async () => {
    const fake = makeFakeCDP();
    let inputs = 0;
    fake.client.send = async () => {
      inputs++;
      return {} as never;
    };
    const server = await startDaemonServer(makeSocketPath(), fake.client, () => {}, undefined, {
      requireLease: true,
    });
    cleanups.push(() => server.close());
    const address = server.server.address();
    if (typeof address !== 'string') throw new Error('Expected Unix socket');
    const first = createCDPClientFromTransport(await createDaemonTransport(address));
    const second = createCDPClientFromTransport(await createDaemonTransport(address));
    cleanups.push(
      () => first.close(),
      () => second.close()
    );
    await expect(second.send('Input.insertText', { text: 'forbidden' })).rejects.toMatchObject({
      code: -32005,
    });
    await first.send('daemon.acquireLease', undefined, null);
    await expect(second.send('daemon.acquireLease', undefined, null)).rejects.toMatchObject({
      code: -32005,
    });
    expect(inputs).toBe(0);
    await first.send('Input.insertText', { text: 'owned' });
    expect(inputs).toBe(1);
    await first.send('daemon.releaseLease', undefined, null);
    await second.send('daemon.acquireLease', undefined, null);
    await second.send('Input.insertText', { text: 'next' });
    expect(inputs).toBe(2);
    expect(fake.client.isConnected).toBe(true);
  });

  test('lost client lease remains fenced until its in-flight browser command settles', async () => {
    const fake = makeFakeCDP();
    let settle!: (value: unknown) => void;
    let entered!: () => void;
    const executing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fake.client.send = (() => {
      entered();
      return new Promise<unknown>((resolve) => {
        settle = resolve;
      });
    }) as CDPClient['send'];
    const server = await startDaemonServer(makeSocketPath(), fake.client, () => {}, undefined, {
      requireLease: true,
    });
    cleanups.push(() => server.close());
    const address = server.server.address();
    if (typeof address !== 'string') throw new Error('Expected Unix socket');
    const first = createCDPClientFromTransport(await createDaemonTransport(address));
    const second = createCDPClientFromTransport(await createDaemonTransport(address));
    cleanups.push(
      () => first.close(),
      () => second.close()
    );
    await first.send('daemon.acquireLease', undefined, null);
    const pending = first.send('Input.insertText', { text: 'unknown' }).catch(() => {});
    await executing;
    await first.close();
    await pending;
    await expect(second.send('daemon.acquireLease', undefined, null)).rejects.toMatchObject({
      code: -32005,
    });
    settle({});
    await new Promise((resolve) => setTimeout(resolve, 10));
    await second.send('daemon.acquireLease', undefined, null);
    expect(fake.client.isConnected).toBe(true);
  });
  test('Runtime exceptions and malformed result codes survive the daemon boundary', async () => {
    const fake = makeFakeCDP();
    const details = {
      exceptionId: 1,
      text: 'Renderer unavailable',
      lineNumber: 0,
      columnNumber: 0,
    };
    let failure = new RuntimeResultError('RUNTIME_EXCEPTION', 'Renderer unavailable', details);
    fake.client.send = async () => {
      throw failure;
    };
    const path = makeSocketPath();
    const server = await startDaemonServer(path, fake.client, () => {});
    cleanups.push(() => server.close());
    const client = createCDPClientFromTransport(await createDaemonTransport(path));
    cleanups.push(() => client.close());
    await expect(
      client.send('Runtime.evaluate', { expression: 'document.title' })
    ).rejects.toMatchObject({ code: 'RUNTIME_EXCEPTION', exceptionDetails: details });
    failure = new RuntimeResultError('PROTOCOL_RESULT_INVALID', 'Malformed Runtime result');
    await expect(
      client.send('Runtime.callFunctionOn', { objectId: 'fixture' })
    ).rejects.toMatchObject({ code: 'PROTOCOL_RESULT_INVALID' });
  });
});
