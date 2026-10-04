import { expect, test } from 'bun:test';
import { Browser } from '../../src/browser/browser.ts';
import type { Transport } from '../../src/cdp/transport.ts';
import { ConnectionSessionOwner } from '../../src/core/sessions/owner.ts';

function fixture() {
  let messages: ((message: string) => void) | undefined;
  let onClose: (() => void) | undefined;
  let opens = 0;
  let closes = 0;
  const transport: Transport = {
    send(raw) {
      const request = JSON.parse(raw) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      let result: unknown = {};
      if (request.method === 'Target.getTargets')
        result = {
          targetInfos: [
            { targetId: 'page', type: 'page', url: 'https://fixture.test', title: 'Fixture' },
          ],
        };
      if (request.method === 'Target.attachToTarget') result = { sessionId: 'attached' };
      if (request.method === 'Runtime.evaluate')
        result = {
          result: {
            type: 'string',
            value:
              request.params?.['expression'] === 'document.title' ? 'Fixture' : { w: 1280, h: 720 },
          },
        };
      queueMicrotask(() => messages?.(JSON.stringify({ id: request.id, result })));
    },
    async close() {
      closes++;
      onClose?.();
    },
    onMessage(handler) {
      messages = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    onError() {},
  };
  const owner = new ConnectionSessionOwner({
    connect: async (options) => {
      opens++;
      return Browser.connect({ ...options, transportFactory: async () => transport });
    },
  });
  const ctx = {
    generation: 'host',
    signal: new AbortController().signal,
    clock: { now: Date.now, sleep: async () => {} },
  };
  return { owner, ctx, opens: () => opens, closes: () => closes };
}

test('two borrowed commands preserve physical connection, target, and authoritative handles', async () => {
  const { owner, ctx, opens, closes } = fixture();
  const handle = await owner.open({ provider: 'generic', wsUrl: 'wss://fixture.test' }, ctx);
  for (let i = 0; i < 2; i++) {
    const lease = await owner.acquire(handle, ctx);
    expect(await (await lease.browser.page()).title()).toBe('Fixture');
    expect('close' in lease.browser).toBe(false);
    await expect(owner.acquire(handle, ctx)).rejects.toMatchObject({ capability: 'session_busy' });
    await lease.detach();
    await lease.detach();
  }
  expect(opens()).toBe(1);
  expect(closes()).toBe(0);
  await expect(owner.acquire({ ...handle, provider: 'cloudflare' }, ctx)).rejects.toMatchObject({
    capability: 'stale_handle',
  });
  await expect(owner.acquire(handle, { ...ctx, generation: 'another' })).rejects.toMatchObject({
    capability: 'stale_handle',
  });
  await owner.release(handle, ctx);
  expect(closes()).toBe(1);
});

test('release stops admission, allows detach, and permits cleanup after cancellation', async () => {
  const { owner, ctx, closes } = fixture();
  const handle = await owner.open({ provider: 'generic', wsUrl: 'wss://fixture.test' }, ctx);
  const lease = await owner.acquire(handle, ctx);
  expect(await owner.release(handle, ctx)).toMatchObject({ status: 'cleanup_pending' });
  await expect(owner.acquire(handle, ctx)).rejects.toMatchObject({
    capability: 'session_releasing',
  });
  await lease.detach();
  const controller = new AbortController();
  controller.abort();
  const result = await owner.release(handle, { ...ctx, signal: controller.signal });
  expect(result.localTerminated).toBe(true);
  expect(closes()).toBe(1);
});
