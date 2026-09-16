/**
 * Unit tests for src/adapters/node/cookie-state-files.ts — resolver grammar,
 * atomic writes, permissions, symlink/directory rejection, and load
 * round-trips. Runs against a tmpdir HOME so it never touches the real
 * `~/.browser-pilot/auth/` directory.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadCookieStateFile,
  resolveCookieStateRef,
  saveCookieStateFile,
} from '../../src/adapters/node/cookie-state-files.ts';
import { CookieStateError } from '../../src/auth/errors.ts';
import type { CookieState } from '../../src/auth/types.ts';

const isWindows = process.platform === 'win32';

function sampleState(overrides: Partial<CookieState> = {}): CookieState {
  return {
    format: 'browser-pilot-cookie-auth',
    schemaVersion: 1,
    savedAt: '2024-01-01T00:00:00.000Z',
    sourceUrl: 'https://example.com/',
    cookies: [
      {
        name: 'session',
        value: 'abc123',
        domain: 'example.com',
        hostOnly: true,
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
        expires: null,
        priority: 'Medium',
        sourceScheme: 'Secure',
        sourcePort: 443,
      },
    ],
    ...overrides,
  };
}

describe('resolveCookieStateRef', () => {
  test('empty/whitespace-only ref is invalid_format', () => {
    for (const ref of ['', '   ', '\t']) {
      expect(() => resolveCookieStateRef(ref)).toThrow(CookieStateError);
      try {
        resolveCookieStateRef(ref);
        throw new Error('expected throw');
      } catch (error) {
        expect((error as CookieStateError).code).toBe('invalid_format');
      }
    }
  });

  test('bare "." and ".." are invalid_format', () => {
    for (const ref of ['.', '..']) {
      try {
        resolveCookieStateRef(ref);
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(CookieStateError);
        expect((error as CookieStateError).code).toBe('invalid_format');
      }
    }
  });

  test('bare name resolves under ~/.browser-pilot/auth/<name>.json', () => {
    const resolved = resolveCookieStateRef('shopify');
    expect(resolved).toBe(join(homedir(), '.browser-pilot', 'auth', 'shopify.json'));
  });

  test('name with underscores/hyphens/digits is valid', () => {
    const resolved = resolveCookieStateRef('my-work_session-2');
    expect(resolved).toBe(join(homedir(), '.browser-pilot', 'auth', 'my-work_session-2.json'));
  });

  test('name containing a dot is treated as a path (CWD-relative), not a name', () => {
    const resolved = resolveCookieStateRef('shopify.json');
    expect(resolved).toBe(join(process.cwd(), 'shopify.json'));
  });

  test('~/x.json expands to the home directory', () => {
    const resolved = resolveCookieStateRef('~/x.json');
    expect(resolved).toBe(join(homedir(), 'x.json'));
  });

  test('bare ~ resolves to the home directory', () => {
    expect(resolveCookieStateRef('~')).toBe(homedir());
  });

  test('absolute path is used as-is (resolved)', () => {
    const abs = join(tmpdir(), 'some', 'file.json');
    expect(resolveCookieStateRef(abs)).toBe(abs);
  });

  test('relative path with slash is resolved against CWD', () => {
    const resolved = resolveCookieStateRef('./sub/dir.json');
    expect(resolved).toBe(join(process.cwd(), 'sub', 'dir.json'));
  });

  test('Windows-style backslash path is classified as a path, not a name', () => {
    // Classification only: contains `\`, so it must not be treated as a
    // bare name and must not throw invalid_format. Actual resolution
    // follows the host platform's `node:path` semantics.
    expect(() => resolveCookieStateRef('C:\\Users\\me\\auth.json')).not.toThrow();
  });

  test('names with spaces (no dot/slash/tilde) are invalid_format', () => {
    try {
      resolveCookieStateRef('my auth');
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CookieStateError);
      expect((error as CookieStateError).code).toBe('invalid_format');
    }
  });

  test('URLs are rejected as invalid_format, not treated as a path', () => {
    try {
      resolveCookieStateRef('https://example.com/x.json');
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CookieStateError);
      expect((error as CookieStateError).code).toBe('invalid_format');
    }
  });
});

describe('saveCookieStateFile / loadCookieStateFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bp-cookie-state-files-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('save creates the auth parent directory with mode 0o700', async () => {
    const target = join(dir, 'nested', 'auth', 'work.json');
    await saveCookieStateFile(target, sampleState());
    const dirStats = await stat(join(dir, 'nested', 'auth'));
    if (!isWindows) {
      expect(dirStats.mode & 0o777).toBe(0o700);
    }
  });

  test('save writes the file with mode 0o600', async () => {
    const target = join(dir, 'work.json');
    await saveCookieStateFile(target, sampleState());
    const fileStats = await stat(target);
    if (!isWindows) {
      expect(fileStats.mode & 0o777).toBe(0o600);
    }
  });

  test('does not chmod an existing parent directory', async () => {
    const authDir = join(dir, 'auth');
    await mkdir(authDir, { recursive: true, mode: 0o755 });
    const target = join(authDir, 'work.json');
    await saveCookieStateFile(target, sampleState());
    const dirStats = await stat(authDir);
    if (!isWindows) {
      expect(dirStats.mode & 0o777).toBe(0o755);
    }
  });

  test('load round-trips a saved state', async () => {
    const target = join(dir, 'work.json');
    const state = sampleState();
    await saveCookieStateFile(target, state);
    const loaded = await loadCookieStateFile(target);
    expect(loaded).toEqual(state);
  });

  test('save then save again without overwrite throws already_exists', async () => {
    const target = join(dir, 'work.json');
    await saveCookieStateFile(target, sampleState());
    try {
      await saveCookieStateFile(target, sampleState());
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CookieStateError);
      expect((error as CookieStateError).code).toBe('already_exists');
    }
  });

  test('save with overwrite: true replaces an existing file', async () => {
    const target = join(dir, 'work.json');
    await saveCookieStateFile(target, sampleState());
    const updated = sampleState({ sourceUrl: 'https://updated.example.com/' });
    await saveCookieStateFile(target, updated, { overwrite: true });
    const loaded = await loadCookieStateFile(target);
    expect(loaded.sourceUrl).toBe('https://updated.example.com/');
  });

  test('atomicity: no partial file remains after a failed save', async () => {
    const target = join(dir, 'sub', 'work.json');
    // Force the write to fail: make the parent path a file, not a directory.
    await writeFile(join(dir, 'sub'), 'not a directory');
    await expect(saveCookieStateFile(target, sampleState())).rejects.toThrow();
    const entries = await readdir(dir);
    // Only the "sub" file exists — no stray .tmp file beside it, and no
    // "sub" directory got created.
    expect(entries).toEqual(['sub']);
  });

  test('no temp files remain after a successful save', async () => {
    const target = join(dir, 'work.json');
    await saveCookieStateFile(target, sampleState());
    const entries = await readdir(dir);
    expect(entries).toEqual(['work.json']);
  });

  test('save rejects a directory target as invalid_format', async () => {
    const target = join(dir, 'work.json');
    await mkdir(target);
    try {
      await saveCookieStateFile(target, sampleState());
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CookieStateError);
      expect((error as CookieStateError).code).toBe('invalid_format');
    }
  });

  test('save rejects a symlink target as invalid_format', async () => {
    if (isWindows) return; // symlink creation may require elevation on Windows
    const real = join(dir, 'real.json');
    await writeFile(real, 'not json');
    const link = join(dir, 'link.json');
    await symlink(real, link);
    try {
      await saveCookieStateFile(link, sampleState());
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CookieStateError);
      expect((error as CookieStateError).code).toBe('invalid_format');
    }
  });

  test('load with no fallback search: missing file is not_found', async () => {
    const target = join(dir, 'missing.json');
    try {
      await loadCookieStateFile(target);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CookieStateError);
      expect((error as CookieStateError).code).toBe('not_found');
    }
  });

  test('load rejects a directory target as not_found', async () => {
    const target = join(dir, 'adir');
    await mkdir(target);
    try {
      await loadCookieStateFile(target);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CookieStateError);
      expect((error as CookieStateError).code).toBe('not_found');
    }
  });

  test('load rejects a symlink target as not_found', async () => {
    if (isWindows) return;
    const real = join(dir, 'real.json');
    await writeFile(real, 'not json');
    const link = join(dir, 'link.json');
    await symlink(real, link);
    try {
      await loadCookieStateFile(link);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CookieStateError);
      expect((error as CookieStateError).code).toBe('not_found');
    }
  });

  test('load rejects an oversized file as invalid_format', async () => {
    const target = join(dir, 'huge.json');
    await writeFile(target, 'x'.repeat(1024 * 1024 + 1));
    try {
      await loadCookieStateFile(target);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CookieStateError);
      expect((error as CookieStateError).code).toBe('invalid_format');
    }
  });

  test('load passes through parseCookieState errors unchanged', async () => {
    const target = join(dir, 'bad.json');
    await writeFile(target, JSON.stringify({ format: 'wrong' }));
    try {
      await loadCookieStateFile(target);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CookieStateError);
      expect((error as CookieStateError).code).toBe('invalid_format');
    }
  });
});
