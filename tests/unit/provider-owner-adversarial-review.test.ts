import { expect, test } from 'bun:test';
import { Browser } from '../../src/browser/browser.ts';
import { createCDPClient } from '../../src/cdp/client.ts';
import type { Transport } from '../../src/cdp/transport.ts';
import { createLeaseCDP } from '../../src/core/sessions/lease-cdp.ts';
import { ConnectionSessionOwner } from '../../src/core/sessions/owner.ts';

function fixture() {
  let message: ((raw: string) => void) | undefined;
  let close: (() => void) | undefined;
  const held: Array<{ id: number }> = [];
  const sent: string[] = [];
  let holdMethod = 'Runtime.reviewHold';
  const transport: Transport = {
    send(raw) {
      const req = JSON.parse(raw);
      sent.push(req.method);
      if (req.method === holdMethod) {
        held.push(req);
        return;
      }
      const result =
        req.method === 'Target.getTargets'
          ? {
              targetInfos: [
                { targetId: 'page', type: 'page', url: 'https://fixture.test', title: '' },
              ],
            }
          : req.method === 'Target.attachToTarget'
            ? { sessionId: 'attached' }
            : {};
      queueMicrotask(() => message?.(JSON.stringify({ id: req.id, result })));
    },
    async close() {
      close?.();
    },
    onMessage(fn) {
      message = fn;
    },
    onClose(fn) {
      close = fn;
    },
    onError() {},
  };
  const ctx = {
    generation: 'host',
    signal: new AbortController().signal,
    clock: { now: Date.now, sleep: async () => {} },
  };
  return {
    transport,
    ctx,
    sent,
    hold(method: string) {
      holdMethod = method;
    },
    settle() {
      for (const req of held.splice(0))
        message?.(JSON.stringify({ id: req.id, result: { targetInfos: [] } }));
    },
  };
}

test('review: detached lease rejects attachToTarget before any CDP dispatch', async () => {
  const f = fixture();
  const client = await createCDPClient('wss://fixture.test', {
    transportFactory: async () => f.transport,
  });
  const lease = createLeaseCDP(client, f.ctx);
  await lease.close();
  const count = f.sent.length;
  try {
    await expect(lease.attachToTarget('page')).rejects.toMatchObject({
      capability: 'stale_handle',
    });
    expect(f.sent.length).toBe(count);
  } finally {
    await client.close();
  }
});

test('review: detach does not free owner while a dispatched command remains unsettled', async () => {
  const f = fixture();
  const client = await createCDPClient('wss://fixture.test', {
    transportFactory: async () => f.transport,
  });
  const browser = Browser.fromCDP(client, { wsUrl: '' });
  const owner = new ConnectionSessionOwner({ connect: async () => browser });
  const handle = await owner.open({ provider: 'generic', wsUrl: 'wss://fixture.test' }, f.ctx);
  const first = await owner.acquire(handle, f.ctx);
  f.hold('Target.getTargets');
  const pending = first.browser.listTargets();
  let detached = false;
  const detachSource = first.detach();
  const detach = detachSource.then(() => {
    detached = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  let second: Awaited<ReturnType<typeof owner.acquire>> | undefined;
  try {
    const admission = await owner.acquire(handle, f.ctx).then(
      (lease) => {
        second = lease;
        return 'acquired';
      },
      (error) => error.capability
    );
    expect(admission).toBe('session_busy');
    expect(detached).toBe(false);
    expect(await owner.release(handle, f.ctx)).toMatchObject({ status: 'cleanup_pending' });
    expect(first.detach()).toBe(detachSource);
  } finally {
    f.settle();
    await pending;
    await detach;
    await second?.detach();
    await owner.release(handle, f.ctx);
  }
});

test('review: first owner page selection obeys the borrowing context deadline', async () => {
  const f = fixture();
  const client = await createCDPClient('wss://fixture.test', {
    transportFactory: async () => f.transport,
  });
  const browser = Browser.fromCDP(client, { wsUrl: '' });
  const owner = new ConnectionSessionOwner({ connect: async () => browser });
  const handle = await owner.open({ provider: 'generic', wsUrl: 'wss://fixture.test' }, f.ctx);
  const lease = await owner.acquire(handle, { ...f.ctx, deadline: Date.now() + 15 });
  f.hold('Target.getTargets');
  const page = lease.browser.page().then(
    () => 'resolved',
    (error) => error.capability ?? 'rejected'
  );
  try {
    const outcome = await Promise.race([
      page,
      new Promise((resolve) => setTimeout(() => resolve('unbounded'), 40)),
    ]);
    expect(['deadline', 'rejected']).toContain(outcome);
  } finally {
    f.settle();
    await page;
    await lease.detach();
    await owner.release(handle, f.ctx);
  }
});

test('review: detached lease also fences auto-attach and debugger helper dispatch', async () => {
  const f = fixture();
  const client = await createCDPClient('wss://fixture.test', {
    transportFactory: async () => f.transport,
  });
  const lease = createLeaseCDP(client, f.ctx);
  await lease.close();
  try {
    await expect(lease.setAutoAttach()).rejects.toMatchObject({ capability: 'stale_handle' });
    await expect(lease.runIfWaitingForDebugger('attached')).rejects.toMatchObject({
      capability: 'stale_handle',
    });
    expect(f.sent).toEqual([]);
  } finally {
    await client.close();
  }
});

test('review: caller cancellation remains effective through a borrowed CDP view', async () => {
  const f = fixture();
  const client = await createCDPClient('wss://fixture.test', {
    transportFactory: async () => f.transport,
  });
  const lease = createLeaseCDP(client, f.ctx);
  const caller = new AbortController();
  const pending = lease.send('Runtime.reviewHold', undefined, undefined, { signal: caller.signal });
  const outcome = pending.then(
    () => 'resolved',
    () => 'cancelled'
  );
  caller.abort();
  try {
    expect(
      await Promise.race([
        outcome,
        new Promise((resolve) => setTimeout(() => resolve('ignored'), 20)),
      ])
    ).toBe('cancelled');
    const count = f.sent.length;
    await expect(
      Promise.resolve().then(() =>
        lease.send('Runtime.evaluate', undefined, undefined, { signal: caller.signal })
      )
    ).rejects.toMatchObject({ capability: 'cancelled' });
    expect(f.sent.length).toBe(count);
  } finally {
    f.settle();
    await pending.catch(() => {});
    await lease.close();
    await client.close();
  }
});

test('review: combined cancellation listeners are removed on success and synchronous send failure', async () => {
  const f = fixture();
  const caller = new AbortController();
  let added = 0,
    removed = 0;
  for (const signal of [caller.signal, f.ctx.signal]) {
    const add = signal.addEventListener.bind(signal),
      remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args: Parameters<AbortSignal['addEventListener']>) => {
      added++;
      add(...args);
    };
    signal.removeEventListener = (...args: Parameters<AbortSignal['removeEventListener']>) => {
      removed++;
      remove(...args);
    };
  }
  let fail = false;
  const client = {
    send() {
      if (fail) throw new Error('sync failure');
      return Promise.resolve({});
    },
  } as unknown as import('../../src/cdp/client.ts').CDPClient;
  const lease = createLeaseCDP(client, f.ctx);
  await lease.send('Runtime.evaluate', undefined, undefined, { signal: caller.signal });
  expect(added).toBe(2);
  expect(removed).toBe(2);
  fail = true;
  expect(() =>
    lease.send('Runtime.evaluate', undefined, undefined, { signal: caller.signal })
  ).toThrow('sync failure');
  expect(added).toBe(4);
  expect(removed).toBe(4);
  await lease.close();
});
