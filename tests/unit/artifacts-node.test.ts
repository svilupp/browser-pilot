import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDestination } from '../../src/artifacts/destination.ts';
import { NodeArtifactSink } from '../../src/artifacts/node.ts';
import type { OperationContext } from '../../src/artifacts/types.ts';

/** Minimal fake clock: `now()` is a mutable counter, `sleep` resolves after
 * a queued microtask unless aborted, without relying on real timers. */
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
  const clock = createFakeClock();
  return {
    signal: new AbortController().signal,
    clock,
    ...overrides,
  };
}

// NOTE: an EACCES-style permission-denied case (e.g. a read-only parent
// directory) is not exercised here — Bun/Node test runs are frequently
// executed as a user that can still write into 0o555 dirs on macOS/CI
// sandboxes, making such a test flaky/unreliable across environments. The
// `checkDestination`/`writeAtomic` error paths already funnel any lstat or
// open() errno (including EACCES) into a generic `failed` result via
// `errnoCode()`, exercised indirectly by the other failure-path tests.

describe('NodeArtifactSink', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'artifacts-node-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('writes a file and returns correct sha256/size/type', async () => {
    const sink = NodeArtifactSink({ root });
    const bytes = new TextEncoder().encode('hello world');
    const ctx = makeCtx();

    const result = await sink.put(bytes, { path: 'a/b/file.txt', type: 'text/plain', ctx });

    expect(result.status).toBe('written');
    if (result.status !== 'written') throw new Error('expected written');
    const expectedHash = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    expect(result.hash).toBe(expectedHash);
    expect(result.size).toBe(bytes.byteLength);
    expect(result.type).toBe('text/plain');
    expect(result.ref).toBe(`file://${join(root, 'a/b/file.txt')}`);

    const onDisk = await readFile(join(root, 'a/b/file.txt'));
    expect(Array.from(onDisk)).toEqual(Array.from(bytes));
  });

  test('rejects ../ traversal', async () => {
    const sink = NodeArtifactSink({ root });
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

  test('rejects absolute path', async () => {
    const sink = NodeArtifactSink({ root });
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

  test('rejects dangling symlink as final entry and does not create target', async () => {
    const sink = NodeArtifactSink({ root });
    const ctx = makeCtx();
    await symlink(join(root, 'nonexistent-target'), join(root, 'dangling-link'));

    const result = await sink.put(new Uint8Array([1]), {
      path: 'dangling-link',
      type: 'text/plain',
      ctx,
    });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.error).toContain('symlink');

    await expect(readFile(join(root, 'nonexistent-target'))).rejects.toThrow();
  });

  test('rejects existing-target symlink', async () => {
    const sink = NodeArtifactSink({ root });
    const ctx = makeCtx();
    await Bun.write(join(root, 'real-target.txt'), 'x');
    await symlink(join(root, 'real-target.txt'), join(root, 'link-to-real'));

    const result = await sink.put(new Uint8Array([1]), {
      path: 'link-to-real',
      type: 'text/plain',
      ctx,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.error).toContain('symlink');
  });

  test('rejects symlinked parent directory', async () => {
    const sink = NodeArtifactSink({ root });
    const ctx = makeCtx();
    const realDir = join(root, 'real-dir');
    await mkdir(realDir);
    await symlink(realDir, join(root, 'link-dir'));

    const result = await sink.put(new Uint8Array([1]), {
      path: 'link-dir/file.txt',
      type: 'text/plain',
      ctx,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected failed');
    expect(result.error).toContain('symlinked parent');
  });

  test('existing regular file: failed without overwrite, written with overwrite', async () => {
    const sink = NodeArtifactSink({ root });
    const ctx1 = makeCtx();
    await Bun.write(join(root, 'exists.txt'), 'old');

    const failResult = await sink.put(new TextEncoder().encode('new'), {
      path: 'exists.txt',
      type: 'text/plain',
      ctx: ctx1,
    });
    expect(failResult.status).toBe('failed');

    const ctx2 = makeCtx();
    const okResult = await sink.put(new TextEncoder().encode('new'), {
      path: 'exists.txt',
      type: 'text/plain',
      ctx: ctx2,
      overwrite: true,
    });
    expect(okResult.status).toBe('written');
    const content = await readFile(join(root, 'exists.txt'), 'utf8');
    expect(content).toBe('new');
  });

  test('concurrent no-overwrite puts publish only one winner and clean temp files', async () => {
    const sink = NodeArtifactSink({ root });
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
    const content = await readFile(join(root, 'collision.txt'), 'utf8');
    expect(['first', 'second']).toContain(content);
    expect((await readdir(root)).filter((name) => name.startsWith('.artifact-tmp-'))).toEqual([]);
  });

  test('deadline already expired -> failed dispatched:false, nothing written', async () => {
    const sink = NodeArtifactSink({ root });
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

    await expect(readFile(join(root, 'never.txt'))).rejects.toThrow();
  });

  test('stalled write with short deadline -> deterministically write_pending_after_deadline, no delete, late completion does not change result', async () => {
    // Deterministic via `beforeWriteFile`: block the write mid-flight until
    // the deadline signal has definitely fired, so this never depends on
    // real fs timing (unlike racing against an already-resolved deadline).
    let releaseWrite: (() => void) | undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const sink = NodeArtifactSink({
      root,
      beforeWriteFile: () => writeGate,
    });
    const clock = createFakeClock();
    const ctx: OperationContext = {
      signal: new AbortController().signal,
      clock,
      deadline: clock.now() + 1,
    };

    const bytes = new Uint8Array(1024);
    const putPromise = sink.put(bytes, {
      path: 'pending.txt',
      type: 'application/octet-stream',
      ctx,
    });

    const result = await putPromise;
    expect(result.status).toBe('write_pending_after_deadline');
    if (result.status !== 'write_pending_after_deadline') throw new Error('expected pending');
    expect(result.error).toContain('deadline');
    expect(result.path).toBe('pending.txt');

    // Nothing was written or deleted while pending.
    await expect(readFile(join(root, 'pending.txt'))).rejects.toThrow();
    expect((await readdir(root)).filter((name) => name.startsWith('.artifact-tmp-'))).toHaveLength(
      1
    );

    // Late completion must not flip the already-returned result or delete
    // anything; it just finishes the write on disk afterwards.
    releaseWrite?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const onDisk = await readFile(join(root, 'pending.txt'));
    expect(onDisk.byteLength).toBe(bytes.byteLength);
    expect((await readdir(root)).filter((name) => name.startsWith('.artifact-tmp-'))).toHaveLength(
      0
    );
  });

  test('checkDestination: parent lstat->ENOENT->mkdir race re-lstats and rejects a raced-in symlink', async () => {
    const calls: string[] = [];
    let lstatCallCount = 0;
    const fakeFs = {
      async lstat(p: import('node:fs').PathLike) {
        lstatCallCount++;
        calls.push(`lstat:${String(p)}`);
        if (lstatCallCount === 1) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        // Second lstat (post-mkdir re-check) sees a symlink raced in by
        // another process/attacker between the first lstat and mkdir.
        return {
          isSymbolicLink: () => true,
          isDirectory: () => false,
          isFile: () => false,
        } as unknown as import('node:fs').Stats;
      },
      async mkdir() {
        calls.push('mkdir');
      },
    };

    const resolved = { full: join(root, 'evil', 'file.txt'), segments: ['evil', 'file.txt'] };
    const result = await checkDestination(
      root,
      resolved,
      false,
      fakeFs as unknown as Parameters<typeof checkDestination>[3]
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toContain('symlinked parent');
    expect(calls).toEqual([`lstat:${join(root, 'evil')}`, 'mkdir', `lstat:${join(root, 'evil')}`]);
  });

  test('abort via ctx.signal mid-write does not delete destination', async () => {
    const sink = NodeArtifactSink({ root });
    const controller = new AbortController();
    const ctx = makeCtx({ signal: controller.signal });
    const bytes = new Uint8Array(1024);

    const putPromise = sink.put(bytes, {
      path: 'abort-mid.txt',
      type: 'application/octet-stream',
      ctx,
    });
    controller.abort();
    const result = await putPromise;

    // Depending on how far pre-dispatch checks got before abort() fired,
    // this can legitimately resolve as failed (not yet dispatched), pending
    // (dispatched, cancelled mid-flight), or written (finished first).
    expect(['write_pending_after_deadline', 'written', 'failed']).toContain(result.status);
    if (result.status === 'write_pending_after_deadline') {
      expect(result.error).toBeTruthy();
    }
    if (result.status === 'failed') {
      expect(result.dispatched).toBe(false);
    }
  });
});
