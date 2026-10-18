import { expect, test } from 'bun:test';
import type { CDPClient } from '../../src/cdp/client.ts';
import { createPassiveTraceConnection } from '../../src/trace/passive-connection.ts';

function fixture(initialBusy = false) {
  let busy = initialBusy;
  const calls: string[] = [];
  const handlers = new Map<string, (params: Record<string, unknown>) => void>();
  const cdp = {
    on(event: string, handler: (params: Record<string, unknown>) => void) {
      handlers.set(event, handler);
    },
    off(event: string) {
      handlers.delete(event);
    },
    async send(method: string, params?: Record<string, unknown>, sessionId?: string | null) {
      calls.push(`${method}:${sessionId ?? 'browser'}`);
      if (method === 'Target.detachFromTarget')
        handlers.get('daemon.subscriptionRevoked')?.({
          sessionId: 'trace-private',
          reason: 'target_detached',
        });
      if (method === 'daemon.attachObserver') return { sessionId: 'trace-private' };
      if (method === 'daemon.acquireLease' && busy) throw new Error('session_busy');
      if (method === 'daemon.acquireLease') return { rawCompatibility: true };
      if (method === 'daemon.subscribeEvents') expect(params?.['sessionId']).toBe('trace-private');
      return {};
    },
  } as unknown as CDPClient;
  return {
    calls,
    cdp,
    revoke(params: Record<string, unknown>) {
      handlers.get('daemon.subscriptionRevoked')?.(params);
    },
    setBusy(value: boolean) {
      busy = value;
    },
  };
}
test('trace installs exact fresh session, releases controller while passive and reacquires before cleanup', async () => {
  const f = fixture();
  const connection = await createPassiveTraceConnection({
    cdp: f.cdp,
    targetId: 'page',
    session: 'work',
    viaDaemon: true,
  });
  await connection.cdp.send('Network.enable');
  await connection.pauseControl();
  expect(f.calls).toEqual([
    'daemon.attachObserver:browser',
    'Network.enable:trace-private',
    'daemon.subscribeEvents:browser',
    'daemon.releaseLease:browser',
  ]);
  await connection.cleanup(async () => {
    f.calls.push('cleanup');
  });
  expect(f.calls.slice(4)).toEqual([
    'daemon.acquireLease:browser',
    'cleanup',
    'Target.detachFromTarget:browser',
    'daemon.unsubscribeEvents:browser',
    'daemon.releaseLease:browser',
  ]);
  await connection.cleanup(async () => {
    throw new Error('must not repeat cleanup');
  });
});
test('busy controller prevents every cleanup script; it never bypasses or opens another connection', async () => {
  const f = fixture(true);
  const connection = await createPassiveTraceConnection({
    cdp: f.cdp,
    targetId: 'page',
    session: 'work',
    viaDaemon: true,
    cleanupTimeoutMs: 1,
  });
  await connection.pauseControl();
  const failure = await connection
    .cleanup(async () => {
      f.calls.push('unsafe_cleanup');
    })
    .then(
      () => undefined,
      (error: unknown) => error
    );
  expect(failure).toBeInstanceOf(Error);
  expect(f.calls).not.toContain('unsafe_cleanup');
  expect(f.calls.filter((call) => call.startsWith('daemon.attachObserver'))).toHaveLength(1);
});
test('collector cleanup errors propagate after removing exact attachment and releasing its grant', async () => {
  const f = fixture();
  const connection = await createPassiveTraceConnection({
    cdp: f.cdp,
    targetId: 'page',
    session: 'work',
    viaDaemon: true,
  });
  await connection.pauseControl();
  const failure = await connection
    .cleanup(async () => {
      throw new Error('cleanup failed');
    })
    .then(
      () => undefined,
      (error: unknown) => error
    );
  expect(failure).toBeInstanceOf(Error);
  expect(f.calls.slice(-3)).toEqual([
    'Target.detachFromTarget:browser',
    'daemon.unsubscribeEvents:browser',
    'daemon.releaseLease:browser',
  ]);
});

test('busy cleanup remains retryable and setup failures clean the exact attachment', async () => {
  const f = fixture(true);
  const connection = await createPassiveTraceConnection({
    cdp: f.cdp,
    targetId: 'page',
    session: 'work',
    viaDaemon: true,
    cleanupTimeoutMs: 1,
  });
  await connection.pauseControl();
  const pending = await connection
    .cleanup(async () => {
      f.calls.push('cleanup');
    })
    .then(
      () => undefined,
      (error: unknown) => error
    );
  expect(pending).toBeInstanceOf(Error);
  expect(f.calls).not.toContain('cleanup');
  f.setBusy(false);
  await connection.cleanup(async () => {
    f.calls.push('cleanup');
  });
  expect(f.calls.slice(-4)).toEqual([
    'cleanup',
    'Target.detachFromTarget:browser',
    'daemon.unsubscribeEvents:browser',
    'daemon.releaseLease:browser',
  ]);
  const initial = fixture();
  const setup = await createPassiveTraceConnection({
    cdp: initial.cdp,
    targetId: 'page',
    session: 'work',
    viaDaemon: true,
  });
  await setup.cleanup(async () => {
    initial.calls.push('dispose_failed_setup');
  });
  expect(initial.calls).not.toContain('daemon.acquireLease:browser');
  expect(initial.calls).toContain('Target.detachFromTarget:browser');
});

test('external revocation terminates capture while self-detach cleanup does not report false failure', async () => {
  const f = fixture();
  const connection = await createPassiveTraceConnection({
    cdp: f.cdp,
    targetId: 'page',
    session: 'work',
    viaDaemon: true,
  });
  let revoked = 0;
  const remove = connection.onRevoked(() => {
    revoked++;
  });
  f.revoke({ sessionId: 'other', reason: 'session_changed' });
  expect(revoked).toBe(0);
  f.revoke({ sessionId: 'trace-private', reason: 'session_changed' });
  expect(revoked).toBe(1);
  await connection.pauseControl();
  await connection.cleanup(async () => {});
  expect(revoked).toBe(1);
  remove();
});
