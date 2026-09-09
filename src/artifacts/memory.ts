import { createDeadlineSignal } from './deadline.ts';
import { sha256Hex } from './hash.ts';
import type { ArtifactPutOptions, ArtifactPutResult, ArtifactSink } from './types.ts';

export interface MemoryArtifactSinkOptions {
  /**
   * Simulate slow storage by delaying the actual write by this many ms
   * (measured via `ctx.clock`). Useful for exercising the
   * `write_pending_after_deadline` path in tests.
   */
  delayMs?: number;
}

interface MemoryArtifactEntry {
  bytes: Uint8Array;
  type: string;
  hash: string;
}

export interface MemoryArtifactSink extends ArtifactSink {
  /** Inspect what has actually landed in the store (test/debug use only). */
  readonly store: ReadonlyMap<string, MemoryArtifactEntry>;
}

function normalizeMemoryPath(rawPath: string): { key: string } | { error: string } {
  if (rawPath.startsWith('/')) return { error: 'absolute paths are not allowed' };
  const parts = rawPath.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') return { error: 'path traversal (..) is not allowed' };
    out.push(part);
  }
  if (out.length === 0) return { error: 'empty path' };
  return { key: out.join('/') };
}

function failed(displayPath: string, error: string, dispatched: boolean): ArtifactPutResult {
  return { status: 'failed', path: displayPath, error, dispatched };
}

/**
 * In-memory `ArtifactSink` implementing the same path-normalization and
 * cancellation contract as `NodeArtifactSink`, without any Node imports —
 * safe to use in Cloudflare Workers and tests.
 */
export function MemoryArtifactSink(options: MemoryArtifactSinkOptions = {}): MemoryArtifactSink {
  const store = new Map<string, MemoryArtifactEntry>();

  return {
    store,
    async put(bytes: Uint8Array, opts: ArtifactPutOptions): Promise<ArtifactPutResult> {
      const { ctx } = opts;

      if (ctx.signal.aborted) return failed(opts.path, 'aborted before start', false);
      if (ctx.deadline !== undefined && ctx.clock.now() >= ctx.deadline) {
        return failed(opts.path, 'deadline exceeded before start', false);
      }

      const normalized = normalizeMemoryPath(opts.path);
      if ('error' in normalized) return failed(opts.path, normalized.error, false);

      if (store.has(normalized.key) && opts.overwrite !== true) {
        return failed(opts.path, 'file exists (overwrite not set)', false);
      }

      const { signal: raceSignal, dispose } = createDeadlineSignal(ctx);
      try {
        const writePromise = (async () => {
          if (options.delayMs !== undefined && options.delayMs > 0) {
            await ctx.clock.sleep(options.delayMs);
          }
          const hash = await sha256Hex(bytes);
          // Re-check at publication time. The preflight `store.has()` above
          // is only an early, user-friendly failure for sequential writes;
          // concurrent puts must arbitrate at the commit point so both cannot
          // report `written` for the same no-overwrite path.
          if (store.has(normalized.key) && opts.overwrite !== true) {
            throw new Error('file exists (overwrite not set)');
          }
          const stored = bytes.slice();
          store.set(normalized.key, { bytes: stored, type: opts.type, hash });
          return {
            ref: `memory://${normalized.key}`,
            path: opts.path,
            size: bytes.byteLength,
            hash: `sha256:${hash}`,
            type: opts.type,
          };
        })();

        const abortPromise = new Promise<{ kind: 'aborted' }>((resolve) => {
          if (raceSignal.aborted) {
            resolve({ kind: 'aborted' });
            return;
          }
          raceSignal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true });
        });

        const raced = await Promise.race([
          writePromise.then((outcome) => ({ kind: 'done' as const, outcome })),
          abortPromise,
        ]);

        if (raced.kind === 'aborted') {
          writePromise.catch(() => {});
          return {
            status: 'write_pending_after_deadline',
            ref: `memory://${normalized.key}`,
            path: opts.path,
            error: 'deadline or cancellation fired after write was dispatched',
          };
        }

        return { status: 'written', ...raced.outcome };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failed(opts.path, message, true);
      } finally {
        dispose();
      }
    },
  };
}
