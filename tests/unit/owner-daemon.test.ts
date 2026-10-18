import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CDPClient } from '../../src/cdp/client.ts';
import { createCDPClientFromTransport } from '../../src/cdp/client.ts';
import { type DaemonIdentity, startDaemonServer } from '../../src/daemon/server.ts';
import { createDaemonTransport } from '../../src/daemon/transport.ts';
import { withOwnerOperations } from '../../src/owner/page-operations.ts';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture(send: CDPClient['send']) {
  const directory = mkdtempSync(join(tmpdir(), 'bp-owner-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const cdp = {
    send,
    onAny() {},
    offAny() {},
    onTargetAttached: () => () => {},
    hasSession: () => false,
  } as unknown as CDPClient;
  return { path: join(directory, 'daemon.sock'), cdp };
}
async function open(path: string, cdp: CDPClient, options: Partial<DaemonIdentity> = {}) {
  const server = await startDaemonServer(path, cdp, () => {}, undefined, {
    requireLease: true,
    ...options,
  });
  cleanups.push(() => server.close());
  return server;
}
async function client(path: string) {
  const result = createCDPClientFromTransport(await createDaemonTransport(path));
  cleanups.push(() => result.close());
  return result;
}

test('all providers require an owner grant, same-grant reacquisition preserves request sequence', async () => {
  let calls = 0;
  const f = fixture((async () => {
    calls++;
    return {};
  }) as CDPClient['send']);
  await open(f.path, f.cdp);
  const a = await client(f.path),
    b = await client(f.path);
  await expect(a.send('Runtime.evaluate', { expression: '1' })).rejects.toThrow('owner fence');
  const grant = await a.send('daemon.acquireLease');
  await a.send('Target.getTargets');
  expect(await a.send<unknown>('daemon.acquireLease')).toEqual(grant);
  await a.send('Target.getTargets');
  await expect(b.send('daemon.acquireLease')).rejects.toThrow('session_busy');
  expect(calls).toBe(2);
});

test('handback drains complete logical operation, freezes new work, and commits once', async () => {
  let writes = 0;
  const f = fixture((async () => ({
    targetInfos: [{ targetId: 'page', type: 'page', url: 'https://fixture.test' }],
  })) as CDPClient['send']);
  await open(f.path, f.cdp, { handback: async () => ++writes });
  const a = await client(f.path);
  await a.send('daemon.acquireLease', { session: 'example' });
  const { operationId } = await a.send<{ operationId: string }>('daemon.beginOperation');
  const handing = a.send('daemon.handback', { targetId: 'page' });
  const duplicate = a.send('daemon.handback', { targetId: 'page' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await expect(a.send('daemon.beginOperation')).rejects.toThrow('owner fence');
  // Continuation of the admitted logical action remains legal while draining.
  await a.send('Input.dispatchMouseEvent', { type: 'mouseReleased' });
  await a.send('daemon.endOperation', { operationId });
  const receipt = await handing;
  expect(await duplicate).toEqual(receipt);
  expect(await a.send<unknown>('daemon.handback', { targetId: 'page' })).toEqual(receipt);
  expect(writes).toBe(1);
  await expect(a.send('Runtime.evaluate')).rejects.toThrow('owner fence');
  await a.send('daemon.releaseLease');
});

test('unknown remote result survives daemon restart and cannot silently reacquire', async () => {
  const f = fixture((async () => {
    throw Object.assign(new Error('remote outcome unknown'), { dispatchState: 'unknown' });
  }) as CDPClient['send']);
  const first = await open(f.path, f.cdp);
  const a = await client(f.path);
  await a.send('daemon.acquireLease');
  await expect(a.send('Input.insertText')).rejects.toThrow('unknown');
  await a.close();
  await first.close();
  await open(f.path, f.cdp);
  const b = await client(f.path);
  await expect(b.send('daemon.acquireLease')).rejects.toThrow('reconciliation');
});

test('disconnect between gesture messages quarantines the whole logical operation', async () => {
  const f = fixture((async () => ({})) as CDPClient['send']);
  await open(f.path, f.cdp);
  const a = await client(f.path),
    b = await client(f.path);
  await a.send('daemon.acquireLease');
  await a.send('daemon.beginOperation');
  await a.send('Input.dispatchMouseEvent', { type: 'mousePressed' });
  await a.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await expect(b.send('daemon.acquireLease')).rejects.toThrow('session_busy');
});

test('strict profile rejects raw Runtime/Input before forwarding, typed hook has one fenced scope', async () => {
  let raw = 0,
    actions = 0;
  const f = fixture((async () => {
    raw++;
    return {};
  }) as CDPClient['send']);
  await open(f.path, f.cdp, {
    ownerActions: {
      rawAllowed: false,
      async revoke() {},
      async dispatch(_method, _params, context) {
        context.assertCurrent?.();
        actions++;
        await context.send('Target.getTargets');
        return { dispatchState: 'dispatched' };
      },
    },
  });
  const a = await client(f.path);
  await a.send('daemon.acquireLease');
  await expect(a.send('Runtime.evaluate', { expression: 'globalThis.mutate()' })).rejects.toThrow(
    'raw CDP'
  );
  await expect(a.send('Input.insertText')).rejects.toThrow('raw CDP');
  await expect(a.send('daemon.attachObserver', { targetId: 'page' })).rejects.toThrow('raw CDP');
  await expect(a.send('daemon.subscribeEvents', { sessionId: 'forged' })).rejects.toThrow(
    'passive raw telemetry'
  );
  expect(raw).toBe(0);
  await a.send('owner.action.dispatch', { approvalId: 'owner-token' });
  expect(actions).toBe(1);
  expect(raw).toBe(1);
});

test('old wire clients cannot dispatch on a new owner even after acquiring without fences', async () => {
  let forwarded = 0;
  const f = fixture((async () => {
    forwarded++;
    return {};
  }) as CDPClient['send']);
  await open(f.path, f.cdp);
  const socket = netConnect(f.path);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  let id = 0;
  const request = (method: string) =>
    new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => {
      socket.once('data', (data) => resolve(JSON.parse(data.toString().trim())));
      socket.write(`${JSON.stringify({ id: ++id, method })}\n`);
    });
  try {
    expect((await request('daemon.acquireLease')).result).toBeDefined();
    expect((await request('Runtime.evaluate')).error?.message).toContain('owner fence');
    expect(forwarded).toBe(0);
  } finally {
    socket.destroy();
  }
});

test('owner private sends recheck deadline after a delayed guard instead of dispatching late', async () => {
  let forwarded = 0;
  const f = fixture((async () => {
    forwarded++;
    return {};
  }) as CDPClient['send']);
  await open(f.path, f.cdp, {
    ownerActions: {
      rawAllowed: false,
      async revoke() {},
      async dispatch(_method, _params, context) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return context.send('Input.insertText', { text: 'late' });
      },
    },
  });
  const a = await client(f.path);
  await a.send('daemon.acquireLease');
  await expect(a.send('owner.action.dispatch', {}, null, { timeout: 10 })).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(forwarded).toBe(0);
});

test('strict typed clients do not receive raw browser CDP events', async () => {
  const f = fixture((async () => ({})) as CDPClient['send']);
  let emit: Parameters<CDPClient['onAny']>[0] | undefined;
  f.cdp.onAny = (callback) => {
    emit = callback;
  };
  await open(f.path, f.cdp, {
    ownerActions: {
      rawAllowed: false,
      async revoke() {},
      async dispatch() {
        return {};
      },
    },
  });
  const a = await client(f.path);
  await a.send('daemon.acquireLease');
  let leaked = 0;
  a.onAny(() => {
    leaked++;
  });
  emit?.('Network.responseReceived', { secret: 'fixture-private' }, 'unrelated-page');
  await a.send('daemon.ping');
  expect(leaked).toBe(0);
});

test('fresh uncertain Page receipt quarantines partial gestures even when the error has no dispatchState', async () => {
  const f = fixture((async () => ({})) as CDPClient['send']);
  await open(f.path, f.cdp);
  const a = await client(f.path),
    b = await client(f.path);
  await a.send('daemon.acquireLease');
  let receipt: { dispatchState: string } | undefined;
  const page = withOwnerOperations(
    {
      getLastActionReceipt: () => receipt,
      async click() {
        await a.send('Input.dispatchMouseEvent', { type: 'mousePressed' });
        receipt = { dispatchState: 'uncertain' };
        throw new Error('partial gesture failed');
      },
    },
    a
  );
  await expect(page.click()).rejects.toThrow('partial gesture failed');
  await a.close();
  await expect(b.send('daemon.acquireLease')).rejects.toThrow('session_busy');
});

test('stale uncertain Page receipt does not taint a later observation failure', async () => {
  const f = fixture((async () => ({})) as CDPClient['send']);
  await open(f.path, f.cdp);
  const a = await client(f.path),
    b = await client(f.path);
  await a.send('daemon.acquireLease');
  const stale = { dispatchState: 'uncertain' };
  const page = withOwnerOperations(
    {
      getLastActionReceipt: () => stale,
      async snapshot() {
        throw new Error('observation failed');
      },
    },
    a
  );
  await expect(page.snapshot()).rejects.toThrow('observation failed');
  await a.send('daemon.releaseLease');
  await b.send('daemon.acquireLease');
});

test('fulfilled batch retains an earlier uncertain step even when the final Page receipt is dispatched', async () => {
  const f = fixture((async () => ({})) as CDPClient['send']);
  await open(f.path, f.cdp);
  const a = await client(f.path),
    b = await client(f.path);
  await a.send('daemon.acquireLease');
  let receipt = { dispatchState: 'not_dispatched' };
  const page = withOwnerOperations(
    {
      getLastActionReceipt: () => receipt,
      async batch() {
        receipt = { dispatchState: 'dispatched' };
        return {
          success: false,
          steps: [{ receipt: { dispatchState: 'uncertain' } }, { dispatchState: 'dispatched' }],
        };
      },
    },
    a
  );
  expect((await page.batch()).success).toBe(false);
  await a.close();
  await expect(b.send('daemon.acquireLease')).rejects.toThrow('session_busy');
});

test('passive telemetry requires socket-owned session and never grants command authority', async () => {
  let inputCalls = 0;
  const f = fixture((async (method: string) => {
    if (method === 'Target.attachToTarget') return { sessionId: 'trace-session' };
    if (method === 'Input.insertText') inputCalls++;
    return {};
  }) as CDPClient['send']);
  let emit: Parameters<CDPClient['onAny']>[0] | undefined;
  f.cdp.onAny = (callback) => {
    emit = callback;
  };
  await open(f.path, f.cdp);
  const a = await client(f.path),
    b = await client(f.path);
  await a.send('daemon.acquireLease', { session: 'trace' });
  await expect(a.send('daemon.subscribeEvents', { sessionId: 'forged-session' })).rejects.toThrow(
    'attached by this controller'
  );
  await a.send('Target.attachToTarget', { targetId: 'page', flatten: true }, null);
  await expect(a.send('daemon.subscribeEvents', { sessionId: 'trace-session' })).rejects.toThrow(
    'observer session'
  );
  await a.send('daemon.attachObserver', { targetId: 'page' });
  await a.send('daemon.subscribeEvents', { sessionId: 'trace-session' });
  await a.send('daemon.releaseLease');
  await b.send('daemon.acquireLease', { session: 'work' });
  await expect(a.send('Input.insertText', { text: 'forbidden' })).rejects.toThrow('owner fence');
  expect(inputCalls).toBe(0);
  const received: string[] = [];
  a.onAny((method) => {
    received.push(method);
  });
  emit?.('Network.requestWillBeSent', {}, 'trace-session');
  emit?.('Network.requestWillBeSent', {}, 'other-session');
  emit?.('Browser.downloadWillBegin', {}, 'trace-session');
  await a.send('daemon.ping');
  expect(received).toEqual(['Network.requestWillBeSent']);
  emit?.('Target.detachedFromTarget', { sessionId: 'trace-session' });
  emit?.('Network.requestWillBeSent', {}, 'trace-session');
  await a.send('daemon.ping');
  expect(received).toEqual(['Network.requestWillBeSent', 'daemon.subscriptionRevoked']);
});

test('disconnected observer cleanup waits for active controller and detaches only disposable observer SID', async () => {
  const detached: string[] = [];
  const f = fixture((async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Target.attachToTarget')
      return {
        sessionId: params?.['targetId'] === 'observe-page' ? 'observer-sid' : 'persistent-sid',
      };
    if (method === 'Target.detachFromTarget') detached.push(String(params?.['sessionId']));
    return {};
  }) as CDPClient['send']);
  await open(f.path, f.cdp);
  const a = await client(f.path),
    b = await client(f.path),
    c = await client(f.path);
  await a.send('daemon.acquireLease', { session: 'trace' });
  await a.send('daemon.attachObserver', { targetId: 'observe-page' });
  await a.send('Target.attachToTarget', { targetId: 'persistent-page', flatten: true }, null);
  await a.send('daemon.subscribeEvents', { sessionId: 'observer-sid' });
  await a.send('daemon.releaseLease');
  await b.send('daemon.acquireLease', { session: 'controller' });
  await a.close();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(detached).toEqual([]);
  await b.send('Input.insertText', { text: 'still-controller' });
  await b.send('daemon.releaseLease');
  await c.send('daemon.acquireLease', { session: 'next' });
  expect(detached).toEqual(['observer-sid']);
});

test('late observer attachment after client disconnect is detached before another controller enters', async () => {
  let enter!: () => void, settle!: (value: unknown) => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const detached: string[] = [];
  const f = fixture((async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Target.attachToTarget') {
      enter();
      return await new Promise<unknown>((resolve) => {
        settle = resolve;
      });
    }
    if (method === 'Target.detachFromTarget') detached.push(String(params?.['sessionId']));
    return {};
  }) as CDPClient['send']);
  await open(f.path, f.cdp);
  const a = await client(f.path),
    b = await client(f.path);
  await a.send('daemon.acquireLease', { session: 'trace' });
  const pending = a.send('daemon.attachObserver', { targetId: 'page' }).catch(() => {});
  await entered;
  await a.close();
  await pending;
  await expect(b.send('daemon.acquireLease')).rejects.toThrow('session_busy');
  settle({ sessionId: 'late-observer' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await b.send('daemon.acquireLease');
  expect(detached).toEqual(['late-observer']);
});

test('handback owns its commit transaction after the client disconnects', async () => {
  let enter!: () => void, settle!: (value: number) => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let commits = 0;
  const f = fixture((async () => ({
    targetInfos: [{ targetId: 'page', type: 'page', url: 'https://fixture.test' }],
  })) as CDPClient['send']);
  await open(f.path, f.cdp, {
    handback: async () => {
      commits++;
      enter();
      return await new Promise<number>((resolve) => {
        settle = resolve;
      });
    },
  });
  const a = await client(f.path),
    b = await client(f.path);
  await a.send('daemon.acquireLease', { session: 'work' });
  const pending = a.send('daemon.handback', { targetId: 'page' }).catch(() => {});
  await entered;
  await a.close();
  await pending;
  await expect(b.send('daemon.acquireLease')).rejects.toThrow('session_busy');
  settle(7);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await b.send('daemon.acquireLease');
  expect(commits).toBe(1);
});

test('release owns its private cleanup transaction after the client disconnects', async () => {
  let enter!: () => void, settle!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let calls = 0;
  const f = fixture((async () => ({})) as CDPClient['send']);
  await open(f.path, f.cdp, {
    ownerActions: {
      rawAllowed: false,
      async dispatch() {
        return {};
      },
      async revoke() {
        calls++;
        enter();
        await new Promise<void>((resolve) => {
          settle = resolve;
        });
      },
    },
  });
  const a = await client(f.path),
    b = await client(f.path);
  await a.send('daemon.acquireLease');
  const pending = a.send('daemon.releaseLease').catch(() => {});
  await entered;
  await a.close();
  await pending;
  await expect(b.send('daemon.acquireLease')).rejects.toThrow('session_busy');
  settle();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await b.send('daemon.acquireLease');
  expect(calls).toBe(1);
});

test('rapid acknowledged disconnect permits next acquisition and runs end/close cleanup once', async () => {
  let revokes = 0;
  const f = fixture((async () => ({})) as CDPClient['send']);
  await open(f.path, f.cdp, {
    ownerActions: {
      rawAllowed: false,
      async dispatch() {
        return {};
      },
      async revoke() {
        revokes++;
      },
    },
  });
  for (let index = 0; index < 10; index++) {
    const current = await client(f.path);
    await current.send('daemon.acquireLease');
    await current.close();
  }
  const final = await client(f.path);
  await final.send('daemon.acquireLease');
  expect(revokes).toBe(10);
});
