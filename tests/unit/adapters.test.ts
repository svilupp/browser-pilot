/**
 * Unit tests for the Node and memory port adapters:
 * InProcessSessionOwner lifecycle + generation fencing, FakeClock semantics,
 * MemorySessionOwner scripting, and nodeClock abort handling.
 */
import { describe, expect, test } from 'bun:test';
import {
  createTestContext,
  FakeClock,
  MemorySecrets,
  MemorySessionOwner,
} from '../../src/adapters/memory/index.ts';
import { InProcessSessionOwner, nodeClock } from '../../src/adapters/node/index.ts';
import { CapabilityError, type ExecutionContext } from '../../src/core/ports.ts';

const WS_URL = 'ws://localhost:9222/devtools/browser/test';

function ctx(generation = 'gen-1'): ExecutionContext {
  return createTestContext({ generation });
}

describe('InProcessSessionOwner', () => {
  test('rejects launch-only Browserless sessions before reading credentials', async () => {
    const owner = new InProcessSessionOwner({
      secrets: {
        get: () => {
          throw new Error('credentials must not be read');
        },
      },
    });
    await expect(owner.open({ provider: 'browserless' }, ctx())).rejects.toMatchObject({
      capability: 'session-reconnect',
      message: expect.stringContaining('custom SessionOwner'),
    });
    expect(owner.size).toBe(0);
  });

  test('rejects disabling Browserbase keepAlive before provider creation', async () => {
    const owner = new InProcessSessionOwner({ secrets: new MemorySecrets({}) });
    await expect(
      owner.open({ provider: 'browserbase', session: { keepAlive: false } }, ctx())
    ).rejects.toMatchObject({ capability: 'session-reconnect' });
    expect(owner.size).toBe(0);
  });

  test('explicit generic endpoints override the trusted host default', async () => {
    const owner = new InProcessSessionOwner({ genericWsUrl: 'ws://host-default.test/browser' });
    const context = ctx();
    const handle = await owner.open({ provider: 'generic', wsUrl: WS_URL }, context);
    expect(await owner.resolve(handle, context)).toEqual({ wsUrl: WS_URL });
    await owner.release(handle, context);
  });

  test('open → resolve → release round-trip with a generic session', async () => {
    const owner = new InProcessSessionOwner();
    const context = ctx();

    const handle = await owner.open({ provider: 'generic', wsUrl: WS_URL }, context);
    expect(handle.provider).toBe('generic');
    expect(handle.generation).toBe('gen-1');
    expect(owner.size).toBe(1);

    const resolved = await owner.resolve(handle, context);
    expect(resolved.wsUrl).toBe(WS_URL);

    const release = await owner.release(handle, context);
    expect(release.status).toBe('released');
    expect(owner.size).toBe(0);

    const again = await owner.release(handle, context);
    expect(again.status).toBe('already_released');
  });

  test('handle is plain JSON and never contains credentials or transport URLs', async () => {
    const owner = new InProcessSessionOwner({
      secrets: new MemorySecrets({ BROWSERBASE_API_KEY: 'super-secret' }),
    });
    const handle = await owner.open({ provider: 'generic', wsUrl: WS_URL }, ctx());

    const serialized = JSON.stringify(handle);
    expect(serialized).toBe(JSON.stringify(JSON.parse(serialized)));
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('ws://');
    expect(Object.keys(handle).sort()).toEqual(
      expect.arrayContaining(['generation', 'id', 'provider'])
    );
    expect('wsUrl' in handle).toBe(false);
    expect('apiKey' in handle).toBe(false);
  });

  test('stale generation → CapabilityError("stale_handle") on resolve and release', async () => {
    const owner = new InProcessSessionOwner();
    const handle = await owner.open({ provider: 'generic', wsUrl: WS_URL }, ctx('gen-1'));
    const nextGeneration = ctx('gen-2');

    for (const call of [
      () => owner.resolve(handle, nextGeneration),
      () => owner.release(handle, nextGeneration),
    ]) {
      let caught: unknown;
      try {
        await call();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CapabilityError);
      expect((caught as CapabilityError).capability).toBe('stale_handle');
    }
  });

  test('forged JSON generation cannot bypass the owner fence', async () => {
    const owner = new InProcessSessionOwner();
    const handle = await owner.open({ provider: 'generic', wsUrl: WS_URL }, ctx('gen-1'));
    const forged = { ...handle, generation: 'gen-2' };
    const nextGeneration = ctx('gen-2');

    await expect(owner.resolve(forged, nextGeneration)).rejects.toMatchObject({
      capability: 'stale_handle',
    });
    await expect(owner.release(forged, nextGeneration)).rejects.toMatchObject({
      capability: 'stale_handle',
    });
  });

  test('lease expiry blocks use but still permits cleanup', async () => {
    const clock = new FakeClock(100);
    const owner = new InProcessSessionOwner({ clock, leaseMs: 10 });
    const context = createTestContext({ generation: 'gen-1', clock });
    const handle = await owner.open({ provider: 'generic', wsUrl: WS_URL }, context);

    clock.advance(10);
    await expect(owner.resolve(handle, context)).rejects.toMatchObject({
      capability: 'lease_expired',
    });
    const controller = new AbortController();
    controller.abort(new Error('operation cancelled'));
    const cleanupContext = createTestContext({
      generation: 'gen-1',
      clock,
      signal: controller.signal,
      deadline: clock.now(),
    });
    const released = await owner.release({ ...handle, leaseExpiresAt: 0 }, cleanupContext);
    expect(released.status).toBe('released');
    expect(owner.size).toBe(0);
  });

  test('resolve of an unknown handle → CapabilityError("stale_handle")', async () => {
    const owner = new InProcessSessionOwner();
    const context = ctx();
    await expect(
      owner.resolve({ id: 'nope', generation: context.generation, provider: 'generic' }, context)
    ).rejects.toThrow(CapabilityError);
  });

  test('open without credentials for a hosted provider surfaces CapabilityError("secrets")', async () => {
    const owner = new InProcessSessionOwner({ secrets: new MemorySecrets({}) });
    let caught: unknown;
    try {
      await owner.open({ provider: 'browserbase' }, ctx());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CapabilityError);
    expect((caught as CapabilityError).capability).toBe('secrets');
  });
});

describe('nodeClock', () => {
  test('sleep resolves after the timeout', async () => {
    await nodeClock.sleep(5);
  });

  test('sleep rejects when the signal aborts', async () => {
    const controller = new AbortController();
    const sleep = nodeClock.sleep(10_000, controller.signal);
    controller.abort(new Error('stop'));
    await expect(sleep).rejects.toThrow('stop');
  });

  test('sleep rejects immediately on an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('too late'));
    await expect(nodeClock.sleep(1, controller.signal)).rejects.toThrow('too late');
  });
});

describe('FakeClock', () => {
  test('sleep resolves only when time is advanced past the due point', async () => {
    const clock = new FakeClock(100);
    let resolved = false;
    const sleep = clock.sleep(50).then(() => {
      resolved = true;
    });

    clock.advance(49);
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(clock.pendingSleeps).toBe(1);

    clock.advance(1);
    await sleep;
    expect(resolved).toBe(true);
    expect(clock.now()).toBe(150);
    expect(clock.pendingSleeps).toBe(0);
  });

  test('sleep rejects when its signal aborts and is removed from the queue', async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const sleep = clock.sleep(1_000, controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(sleep).rejects.toThrow('cancelled');
    expect(clock.pendingSleeps).toBe(0);
  });

  test('cannot go backwards', () => {
    const clock = new FakeClock(10);
    expect(() => clock.setTime(5)).toThrow(/backwards/);
  });
});

describe('MemorySessionOwner', () => {
  test('scripted open/resolve/release with call recording', async () => {
    const owner = new MemorySessionOwner({ wsUrl: 'ws://scripted/1' });
    const context = ctx();

    const handle = await owner.open({ provider: 'browserbase' }, context);
    const resolved = await owner.resolve(handle, context);
    expect(resolved.wsUrl).toBe('ws://scripted/1');

    const release = await owner.release(handle, context);
    expect(release.status).toBe('released');
    expect(owner.opened).toHaveLength(1);
    expect(owner.resolvedHandles).toHaveLength(1);
    expect(owner.releasedHandles).toHaveLength(1);
  });

  test('enforces generation fencing like the node owner', async () => {
    const owner = new MemorySessionOwner();
    const handle = await owner.open({ provider: 'generic' }, ctx('gen-1'));
    await expect(owner.resolve(handle, ctx('gen-2'))).rejects.toThrow(CapabilityError);
  });

  test('forged JSON generation cannot bypass the owner fence', async () => {
    const owner = new MemorySessionOwner();
    const handle = await owner.open({ provider: 'generic' }, ctx('gen-1'));
    const forged = { ...handle, generation: 'gen-2' };
    const nextGeneration = ctx('gen-2');

    await expect(owner.resolve(forged, nextGeneration)).rejects.toMatchObject({
      capability: 'stale_handle',
    });
    await expect(owner.release(forged, nextGeneration)).rejects.toMatchObject({
      capability: 'stale_handle',
    });
  });

  test('lease expiry blocks use but still permits cleanup', async () => {
    const clock = new FakeClock(100);
    const owner = new MemorySessionOwner({ clock, leaseMs: 10 });
    const context = createTestContext({ generation: 'gen-1', clock });
    const handle = await owner.open({ provider: 'generic' }, context);

    clock.advance(10);
    await expect(owner.touch(handle, context)).rejects.toMatchObject({
      capability: 'lease_expired',
    });
    const controller = new AbortController();
    controller.abort(new Error('operation cancelled'));
    const released = await owner.release(
      { ...handle, leaseExpiresAt: 0 },
      {
        ...context,
        signal: controller.signal,
        deadline: clock.now(),
      }
    );
    expect(released.status).toBe('released');
    expect(owner.size).toBe(0);
  });

  test('pending and throwing releases stay retryable', async () => {
    const firstError = new Error('temporary close failure');
    const owner = new MemorySessionOwner({
      releaseResults: [
        { status: 'cleanup_pending', sessionId: 'memory-session-1', error: 'try again' },
        firstError,
        { status: 'released', sessionId: 'memory-session-1' },
      ],
    });
    const context = ctx();
    const handle = await owner.open({ provider: 'generic' }, context);

    const pending = await owner.release(handle, context);
    expect(pending.status).toBe('cleanup_pending');
    expect(owner.size).toBe(1);
    await expect(owner.release(handle, context)).rejects.toThrow('temporary close failure');
    expect(owner.size).toBe(1);
    const released = await owner.release(handle, context);
    expect(released.status).toBe('released');
    expect(owner.size).toBe(0);
    expect(owner.releasedHandles).toHaveLength(3);
  });

  test('concurrent releases share one cleanup attempt', async () => {
    const owner = new MemorySessionOwner();
    const context = ctx();
    const handle = await owner.open({ provider: 'generic' }, context);

    const results = await Promise.all([
      owner.release(handle, context),
      owner.release(handle, context),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.status).toBe('released');
    expect(owner.releasedHandles).toHaveLength(2);
  });

  test('scripted failures and release results', async () => {
    const failing = new MemorySessionOwner({ openError: new Error('quota exceeded') });
    await expect(failing.open({ provider: 'generic' }, ctx())).rejects.toThrow('quota exceeded');

    const pending = new MemorySessionOwner({
      releaseResult: { status: 'cleanup_pending', sessionId: 'x', error: 'still running' },
    });
    const handle = await pending.open({ provider: 'generic' }, ctx());
    const release = await pending.release(handle, ctx());
    expect(release.status).toBe('cleanup_pending');
  });
});

describe('MemorySecrets', () => {
  test('reads from the record; set() mutates', () => {
    const secrets = new MemorySecrets({ A: '1' });
    expect(secrets.get('A')).toBe('1');
    expect(secrets.get('B')).toBeUndefined();
    secrets.set('B', '2');
    expect(secrets.get('B')).toBe('2');
  });
});
