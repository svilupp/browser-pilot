// Test-only internals for `NodeArtifactSink`'s destination validation
// (path scoping + TOCTOU-safe parent-directory checks). Not part of the
// public artifacts API surface; imported directly by unit tests that need
// to inject a fake `DestinationFs` to simulate races deterministically.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface DestinationFs {
  lstat: typeof fs.lstat;
  mkdir: typeof fs.mkdir;
}

export interface ResolvedPath {
  full: string;
  segments: string[];
}

export function resolveScopedPath(root: string, relPath: string): ResolvedPath | { error: string } {
  if (path.isAbsolute(relPath)) return { error: 'absolute paths are not allowed' };
  const normalized = path.normalize(relPath);
  const segments = normalized.split(path.sep).filter((segment) => segment.length > 0);
  if (segments.length === 0) return { error: 'empty path' };
  if (segments.some((segment) => segment === '..')) {
    return { error: 'path traversal (..) is not allowed' };
  }
  const rootResolved = path.resolve(root);
  const full = path.join(rootResolved, ...segments);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
    return { error: 'path escapes root' };
  }
  return { full, segments };
}

function errnoCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'unknown';
}

/**
 * Walk every path component with `lstat` (never `stat`) to reject symlinked
 * parent directories, then validate the final entry per the Appendix A
 * filesystem contract.
 */
export async function checkDestination(
  root: string,
  resolved: ResolvedPath,
  overwrite: boolean,
  destFs: DestinationFs = fs
): Promise<{ ok: true } | { ok: false; error: string }> {
  let current = root;
  for (let i = 0; i < resolved.segments.length - 1; i++) {
    const segment = resolved.segments[i];
    if (segment === undefined) continue;
    current = path.join(current, segment);
    try {
      const st = await destFs.lstat(current);
      if (st.isSymbolicLink())
        return { ok: false, error: 'symlinked parent directory not allowed' };
      if (!st.isDirectory())
        return { ok: false, error: 'parent path component is not a directory' };
    } catch (error) {
      const code = errnoCode(error);
      if (code === 'ENOENT') {
        try {
          await destFs.mkdir(current);
        } catch (mkdirError) {
          const mkdirCode = errnoCode(mkdirError);
          if (mkdirCode !== 'EEXIST') {
            return { ok: false, error: `failed to create parent directory: ${mkdirCode}` };
          }
        }
        // Re-`lstat` after `mkdir` (success or EEXIST): a concurrent writer
        // could have raced in a symlink between the first `lstat` and this
        // `mkdir` call (TOCTOU). Never trust the post-mkdir state blindly.
        try {
          const st2 = await destFs.lstat(current);
          if (st2.isSymbolicLink())
            return { ok: false, error: 'symlinked parent directory not allowed' };
          if (!st2.isDirectory())
            return { ok: false, error: 'parent path component is not a directory' };
        } catch (relstatError) {
          return {
            ok: false,
            error: `parent path inspection failed: ${errnoCode(relstatError)}`,
          };
        }
        continue;
      }
      return { ok: false, error: `parent path inspection failed: ${code}` };
    }
  }

  try {
    const st = await fs.lstat(resolved.full);
    if (st.isSymbolicLink()) return { ok: false, error: 'symlink' };
    if (st.isFile()) {
      if (!overwrite) return { ok: false, error: 'file exists (overwrite not set)' };
      return { ok: true };
    }
    return { ok: false, error: 'target exists and is not a regular file' };
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT') return { ok: true };
    return { ok: false, error: `final path inspection failed: ${code}` };
  }
}
