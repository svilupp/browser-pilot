import { describe, expect, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { MemoryArtifactSink } from '../../src/artifacts/memory.ts';
import type { OperationContext } from '../../src/artifacts/types.ts';

/** Minimal fake clock matching the Clock port shape, local to this test file. */
function createFakeClock() {
  let current = 0;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
    sleep(ms: number, signal?: AbortSignal): Promise<void> {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        const timer = setTimeout(() => resolve(), ms);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true }
        );
      });
    },
  };
}

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    signal: new AbortController().signal,
    clock: createFakeClock(),
    ...overrides,
  };
}

describe('MemoryArtifactSink', () => {
  test('writes bytes and returns correct sha256/size/type', async () => {
    const sink = MemoryArtifactSink();
    const bytes = new TextEncoder().encode('hello world');
    const ctx = makeCtx();

    const result = await sink.put(bytes, { path: 'a/b/file.txt', type: 'text/plain', ctx });

    expect(result.status).toBe('written');
    if (result.status !== 'written') throw new Error('expected written');
    const expectedHash = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    expect(result.hash).toBe(expectedHash);
    expect(result.size).toBe(bytes.byteLength);
    expect(result.type).toBe('text/plain');
    expect(result.ref).toBe('memory://a/b/file.txt');

    const stored = sink.store.get('a/b/file.txt');
    expect(stored).toBeDefined();
    expect(stored?.bytes).toEqual(bytes);
  });

  test('rejects ../ traversal', async () => {
    const sink = MemoryArtifactSink();
    const ctx = makeCtx();
    const result = await sink.put(new Uint8Array([1]), {
      path: '../escape.txt',
      type: 'text/plain',
      ctx,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.dispatched).toBe(false);
  });

  test('normalizes a/../b to b, matching NodeArtifactSink semantics', async () => {
    const sink = MemoryArtifactSink();
    const ctx = makeCtx();
    const result = await sink.put(new Uint8Array([1]), {
      path: 'a/../b',
      type: 'text/plain',
      ctx,
    });
    expect(result.status).toBe('written');
    if (result.status !== 'written') throw new Error('expected written');
    expect(result.ref).toBe('memory://b');
    expect(sink.store.has('b')).toBe(true);
    expect(sink.store.has('a')).toBe(false);
  });

  test('still rejects traversal that escapes the root after normalization', async () => {
    const sink = MemoryArtifactSink();
    const ctx = makeCtx();
    const result = await sink.put(new Uint8Array([1]), {
      path: 'a/../../escape.txt',
      type: 'text/plain',
      ctx,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.dispatched).toBe(false);
  });

  test('rejects put("a/b") after put("a") - parent path component is not a directory', async () => {
    const sink = MemoryArtifactSink();
    const first = await sink.put(new Uint8Array([1]), {
      path: 'a',
      type: 'text/plain',
      ctx: makeCtx(),
    });
    expect(first.status).toBe('written');

    const result = await sink.put(new Uint8Array([2]), {
      path: 'a/b',
      type: 'text/plain',
      ctx: makeCtx(),
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.dispatched).toBe(false);
    expect(sink.store.has('a/b')).toBe(false);
  });

  test('rejects put("a") when "a" is already a directory (has a/b stored)', async () => {
    const sink = MemoryArtifactSink();
    const first = await sink.put(new Uint8Array([1]), {
      path: 'a/b',
      type: 'text/plain',
      ctx: makeCtx(),
    });
    expect(first.status).toBe('written');

    const result = await sink.put(new Uint8Array([2]), {
      path: 'a',
      type: 'text/plain',
      ctx: makeCtx(),
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.dispatched).toBe(false);
    expect(sink.store.has('a')).toBe(false);
  });

  test('rejects absolute path', async () => {
    const sink = MemoryArtifactSink();
    const ctx = makeCtx();
    const result = await sink.put(new Uint8Array([1]), {
      path: '/etc/passwd',
      type: 'text/plain',
      ctx,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.dispatched).toBe(false);
  });

  test('existing entry: failed without overwrite, written with overwrite', async () => {
    const sink = MemoryArtifactSink();
    const ctx1 = makeCtx();
    await sink.put(new TextEncoder().encode('old'), {
      path: 'exists.txt',
      type: 'text/plain',
      ctx: ctx1,
    });

    const failResult = await sink.put(new TextEncoder().encode('new'), {
      path: 'exists.txt',
      type: 'text/plain',
      ctx: makeCtx(),
    });
    expect(failResult.status).toBe('failed');

    const okResult = await sink.put(new TextEncoder().encode('new'), {
      path: 'exists.txt',
      type: 'text/plain',
      ctx: makeCtx(),
      overwrite: true,
    });
    expect(okResult.status).toBe('written');
    expect(new TextDecoder().decode(sink.store.get('exists.txt')?.bytes)).toBe('new');
  });

  test('concurrent no-overwrite puts publish only one winner', async () => {
    const sink = MemoryArtifactSink();
    const ctx = makeCtx();
    const [first, second] = await Promise.all([
      sink.put(new TextEncoder().encode('first'), {
        path: 'collision.txt',
        type: 'text/plain',
        ctx,
      }),
      sink.put(new TextEncoder().encode('second'), {
        path: 'collision.txt',
        type: 'text/plain',
        ctx,
      }),
    ]);

    expect([first.status, second.status].sort()).toEqual(['failed', 'written']);
    const content = new TextDecoder().decode(sink.store.get('collision.txt')?.bytes);
    expect(['first', 'second']).toContain(content);
  });

  test('already aborted signal -> failed', async () => {
    const sink = MemoryArtifactSink();
    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx({ signal: controller.signal });

    const result = await sink.put(new Uint8Array([1]), {
      path: 'never.txt',
      type: 'text/plain',
      ctx,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.dispatched).toBe(false);
    expect(sink.store.has('never.txt')).toBe(false);
  });

  test('deadline already expired -> failed dispatched:false, nothing stored', async () => {
    const sink = MemoryArtifactSink();
    const clock = createFakeClock();
    clock.advance(1000);
    const ctx: OperationContext = {
      signal: new AbortController().signal,
      clock,
      deadline: 500,
    };

    const result = await sink.put(new Uint8Array([1]), {
      path: 'never.txt',
      type: 'text/plain',
      ctx,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.dispatched).toBe(false);
    expect(sink.store.has('never.txt')).toBe(false);
  });

  test('slow write (delayMs) racing an expired deadline -> write_pending_after_deadline, entry lands late unchanged result', async () => {
    const sink = MemoryArtifactSink({ delayMs: 1000 });
    const clock = createFakeClock();
    const ctx: OperationContext = {
      signal: new AbortController().signal,
      clock,
      deadline: clock.now() + 10,
    };

    const putPromise = sink.put(new Uint8Array([1, 2, 3]), {
      path: 'slow.txt',
      type: 'text/plain',
      ctx,
    });

    const result = await putPromise;
    expect(result.status).toBe('write_pending_after_deadline');
    if (result.status !== 'write_pending_after_deadline') throw new Error('expected pending');
    expect(result.path).toBe('slow.txt');
    expect(sink.store.has('slow.txt')).toBe(false);

    // Let the delayed write actually complete; the already-returned result
    // must not change, but the store should eventually receive the entry.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(sink.store.has('slow.txt')).toBe(true);
  });

  test('abort via ctx.signal mid-write -> pending, no partial state visible before completion', async () => {
    const sink = MemoryArtifactSink({ delayMs: 50 });
    const controller = new AbortController();
    const ctx = makeCtx({ signal: controller.signal });

    const putPromise = sink.put(new Uint8Array([9]), {
      path: 'abort-mid.txt',
      type: 'text/plain',
      ctx,
    });
    controller.abort();
    const result = await putPromise;

    expect(result.status).toBe('write_pending_after_deadline');
  });
});
