import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createDeadlineSignal } from './deadline.ts';
import { checkDestination, type DestinationFs, resolveScopedPath } from './destination.ts';
import { sha256Hex } from './hash.ts';
import type { ArtifactPutOptions, ArtifactPutResult, ArtifactSink, Clock } from './types.ts';

export interface NodeArtifactSinkOptions {
  root: string;
  clock?: Clock;
  /** Test-only injection point for the fs primitives used by parent-directory
   * checks (`lstat`/`mkdir`), so races can be simulated deterministically. */
  fsOverrides?: Partial<Pick<typeof fs, 'lstat' | 'mkdir'>>;
  /** Test-only hook invoked mid-write (after the temp file is opened, before
   * bytes are written), used to deterministically simulate a stalled write
   * racing a deadline/cancellation. */
  beforeWriteFile?: () => Promise<void>;
}

function failed(displayPath: string, error: string, dispatched: boolean): ArtifactPutResult {
  return { status: 'failed', path: displayPath, error, dispatched };
}

function fileRef(fullPath: string): string {
  return `file://${fullPath}`;
}

interface WriteOutcome {
  ref: string;
  path: string;
  size: number;
  hash: string;
  type: string;
}

/**
 * Write via a same-directory temp file (O_EXCL), then publish atomically.
 *
 * `rename()` replaces an existing destination on Node, so it cannot enforce
 * the default no-overwrite contract after the preflight check. For that case,
 * `link()` publishes the temp inode with an atomic EEXIST collision. Explicit
 * overwrite keeps the replacement semantics and uses rename().
 */
async function writeAtomic(
  fullPath: string,
  displayPath: string,
  bytes: Uint8Array,
  type: string,
  overwrite: boolean,
  /** Test-only hook invoked after `open`/before `writeFile`, so a slow or
   * stalled write can be simulated deterministically (a real fs write
   * completes far too fast to reliably race a fake deadline). */
  beforeWriteFile?: () => Promise<void>
): Promise<WriteOutcome> {
  const dir = path.dirname(fullPath);
  const tempName = `.artifact-tmp-${crypto.randomBytes(8).toString('hex')}`;
  const tempPath = path.join(dir, tempName);
  let created = false;
  let handle: fs.FileHandle | undefined;
  try {
    try {
      handle = await fs.open(
        tempPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
      );
      created = true;
      if (beforeWriteFile) await beforeWriteFile();
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle?.close();
    }

    const hash = await sha256Hex(bytes);
    if (overwrite) {
      await fs.rename(tempPath, fullPath);
    } else {
      // Hard-link publication fails atomically when another writer won the
      // no-overwrite race. The destination is never replaced.
      await fs.link(tempPath, fullPath);
      await fs.unlink(tempPath);
    }
    created = false;

    return {
      ref: fileRef(fullPath),
      path: displayPath,
      size: bytes.byteLength,
      hash: `sha256:${hash}`,
      type,
    };
  } finally {
    // Clean up both failed writes and EEXIST collisions. `created` guards
    // against unlinking a different writer's temp file if the random name
    // ever collides at O_EXCL open time.
    if (created) await fs.unlink(tempPath).catch(() => {});
  }
}

/** Node.js filesystem-backed `ArtifactSink` implementing the Appendix A contract. */
export function NodeArtifactSink(options: NodeArtifactSinkOptions): ArtifactSink {
  const root = path.resolve(options.root);
  const destFs: DestinationFs = {
    lstat: options.fsOverrides?.lstat ?? fs.lstat,
    mkdir: options.fsOverrides?.mkdir ?? fs.mkdir,
  };

  return {
    async put(bytes: Uint8Array, opts: ArtifactPutOptions): Promise<ArtifactPutResult> {
      const { ctx } = opts;

      if (ctx.signal.aborted) return failed(opts.path, 'aborted before start', false);
      if (ctx.deadline !== undefined && ctx.clock.now() >= ctx.deadline) {
        return failed(opts.path, 'deadline exceeded before start', false);
      }

      // Arm the deadline signal before the preflight checks so a slow
      // `checkDestination` (parent-directory walk, mkdir) is itself bounded
      // by the deadline/cancellation, not just the subsequent write.
      const { signal: raceSignal, dispose } = createDeadlineSignal(ctx);
      try {
        const resolved = resolveScopedPath(root, opts.path);
        if ('error' in resolved) return failed(opts.path, resolved.error, false);

        const checkPromise = checkDestination(root, resolved, opts.overwrite === true, destFs);
        const checkAbortPromise = new Promise<{ kind: 'aborted' }>((resolve) => {
          if (raceSignal.aborted) {
            resolve({ kind: 'aborted' });
            return;
          }
          raceSignal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true });
        });
        const checkRaced = await Promise.race([
          checkPromise.then((check) => ({ kind: 'done' as const, check })),
          checkAbortPromise,
        ]);
        if (checkRaced.kind === 'aborted') {
          return failed(opts.path, 'aborted or deadline exceeded before start', false);
        }
        if (!checkRaced.check.ok) return failed(opts.path, checkRaced.check.error, false);

        if (ctx.signal.aborted) return failed(opts.path, 'aborted before start', false);
        if (ctx.deadline !== undefined && ctx.clock.now() >= ctx.deadline) {
          return failed(opts.path, 'deadline exceeded before start', false);
        }

        // Dispatch: once the write starts, cancellation no longer deletes
        // the destination — it only changes what result is returned.
        const writePromise = writeAtomic(
          resolved.full,
          opts.path,
          bytes,
          opts.type,
          opts.overwrite === true,
          options.beforeWriteFile
        );

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
          // Swallow late completion/errors — the destination (or temp file)
          // is left untouched per the contract.
          writePromise.catch(() => {});
          return {
            status: 'write_pending_after_deadline',
            ref: fileRef(resolved.full),
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
