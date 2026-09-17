/**
 * Node file-system helpers for cookie-state (`browser-pilot-cookie-auth`)
 * snapshots. Resolves a "name-or-path" reference (PLAN.md §1.8/P3) to an
 * absolute path, then loads/saves the file with atomic-write and
 * symlink/directory-rejection semantics mirroring `src/cli/session.ts`.
 *
 * Node-only: not exported from `browser-pilot/core`.
 */

import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseCookieState, serializeCookieState } from '../../auth/cookie-state.ts';
import { CookieStateError } from '../../auth/errors.ts';
import type { CookieState } from '../../auth/types.ts';

const MAX_SNAPSHOT_BYTES = 1024 * 1024; // 1 MiB, matches src/auth/cookie-state.ts

/** Bare name: letters/digits/underscore/hyphen, no dots, 1-64 chars. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function isErrnoException(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

/**
 * Resolve a "name-or-path" cookie-state reference to an absolute path.
 *
 * Grammar (no fallback search):
 * 1. empty/whitespace-only → `invalid_format`.
 * 2. bare `.` or `..` → `invalid_format` (checked before path classification).
 * 3. `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/` (no dots) → a *name*, resolved to
 *    `~/.browser-pilot/auth/<name>.json`.
 * 4. contains a dot, `/`, `\`, or a leading `~` → a *path* (CWD-relative,
 *    absolute, or `~`-expanded); URL schemes (`scheme://`) are rejected.
 * 5. anything else (bare words with spaces, etc.) → `invalid_format`.
 */
export function resolveCookieStateRef(ref: string): string {
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    throw new CookieStateError(
      'invalid_format',
      'Cookie state reference must be a non-empty string'
    );
  }
  if (ref === '.' || ref === '..') {
    throw new CookieStateError('invalid_format', 'Cookie state reference must not be "." or ".."');
  }
  if (NAME_RE.test(ref)) {
    return join(homedir(), '.browser-pilot', 'auth', `${ref}.json`);
  }

  // A URL (`scheme://...`) contains `/` but is not a filesystem path
  // reference — reject explicitly before the path-classification branch.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(ref)) {
    throw new CookieStateError(
      'invalid_format',
      `Cookie state reference must not be a URL: ${ref}`
    );
  }

  const looksLikePath =
    ref.includes('.') || ref.includes('/') || ref.includes('\\') || ref.startsWith('~');
  if (!looksLikePath) {
    throw new CookieStateError(
      'invalid_format',
      `Cookie state reference is neither a valid name nor a path: ${ref}`
    );
  }

  if (ref === '~') return homedir();
  if (ref.startsWith('~/') || ref.startsWith('~\\')) {
    return join(homedir(), ref.slice(2));
  }
  if (isAbsolute(ref)) return resolve(ref);
  return resolve(process.cwd(), ref);
}

/**
 * Load and parse a cookie-state file. `not_found` when missing (or when the
 * target is a symlink/directory — no fallback search, no traversal),
 * `invalid_format` when it exceeds the 1 MiB cap, `io_error` for other
 * filesystem failures (message never echoes file contents), and any
 * `parseCookieState` error passed through unchanged.
 */
export async function loadCookieStateFile(ref: string): Promise<CookieState> {
  const path = resolveCookieStateRef(ref);

  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) {
      throw new CookieStateError('not_found', `Cookie state file not found: ${path}`);
    }
    throw new CookieStateError('io_error', `Failed to stat cookie state file: ${path}`);
  }

  if (!stats.isFile()) {
    // Symlinks and directories are treated as missing — no traversal.
    throw new CookieStateError('not_found', `Cookie state file not found: ${path}`);
  }
  if (stats.size > MAX_SNAPSHOT_BYTES) {
    throw new CookieStateError('invalid_format', 'Cookie state file exceeds 1 MiB');
  }

  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    throw new CookieStateError('io_error', `Failed to read cookie state file: ${path}`);
  }

  return parseCookieState(content);
}

/**
 * Save a cookie state to disk. Writes go through a sibling temp file
 * (`mode: 0o600`, opened `'wx'`), `fsync`'d, then published via `rename`
 * (overwrite) or `link` (create-only — `EEXIST` becomes `already_exists`).
 * The parent auth directory is created with `mode: 0o700` if missing;
 * an existing parent directory's mode is never touched. Symlink/directory
 * targets are rejected as `invalid_format` before any write is attempted.
 * Modes are best-effort on Windows.
 */
export async function saveCookieStateFile(
  ref: string,
  state: CookieState,
  opts: { overwrite?: boolean } = {}
): Promise<{ path: string }> {
  const path = resolveCookieStateRef(ref);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  try {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      throw new CookieStateError(
        'invalid_format',
        `Refusing to write to a symlink or directory: ${path}`
      );
    }
  } catch (error) {
    if (error instanceof CookieStateError) throw error;
    if (!isErrnoException(error, 'ENOENT')) {
      throw new CookieStateError('io_error', `Failed to stat cookie state target: ${path}`);
    }
  }

  const content = serializeCookieState(state);
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${content}\n`, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (opts.overwrite) {
      await rename(tempPath, path);
    } else {
      try {
        await link(tempPath, path);
      } catch (error) {
        if (isErrnoException(error, 'EEXIST')) {
          throw new CookieStateError('already_exists', `Cookie state file already exists: ${path}`);
        }
        throw error;
      } finally {
        await unlink(tempPath).catch(() => {});
      }
    }
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    if (error instanceof CookieStateError) throw error;
    throw new CookieStateError('io_error', `Failed to save cookie state file: ${path}`);
  }

  return { path };
}
