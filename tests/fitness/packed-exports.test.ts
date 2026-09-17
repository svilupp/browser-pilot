/**
 * Fitness: package exports resolve to emitted files
 *
 * Runs the real build (into an isolated `.tmp/packed-dist` output directory,
 * so it never races `rm -rf dist` against a concurrent `bun run build` /
 * `bun run api:check` that reads the real `dist/`), then asserts every
 * `exports` entry in package.json would point at an emitted file, that a
 * packed tarball built from a shadow copy would include them (npm pack
 * --dry-run against a scratch package directory, scripts ignored so the
 * build is not run twice), and that the portable core entry is importable
 * and exposes its contract surface.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const BUILD_TIMEOUT_MS = 240_000;
const PACKED_OUT_DIR = resolve(REPO_ROOT, '.tmp/packed-dist');

interface PackageJson {
  exports: Record<string, Record<string, string>>;
  files: string[];
}

async function readPackageJson(): Promise<PackageJson> {
  return JSON.parse(await readFile(resolve(REPO_ROOT, 'package.json'), 'utf8')) as PackageJson;
}

/** Map an `exports` target like `./dist/index.mjs` to the isolated build output. */
function toPackedPath(target: string): string {
  const relative = target.replace(/^\.\/dist\//, '');
  return resolve(PACKED_OUT_DIR, relative);
}

describe('packed exports', () => {
  test(
    'build emits every exports target and the portable entries are importable',
    async () => {
      await rm(PACKED_OUT_DIR, { recursive: true, force: true });

      // Note: no `--clean` flag here. tsup's config is a two-entry array
      // (library + CLI); each config independently wipes the whole out-dir
      // when `clean` is set, so both configs racing `--clean` against a
      // shared out-dir can delete files the other config just wrote. The
      // `rm` above already gives us a clean directory once, up front.
      const build = Bun.spawnSync(['bunx', 'tsup', '--out-dir', PACKED_OUT_DIR], {
        cwd: REPO_ROOT,
      });
      if (build.exitCode !== 0) {
        throw new Error(
          `tsup build (isolated out-dir) failed (${build.exitCode}):\n${build.stderr.toString()}\n${build.stdout.toString()}`
        );
      }

      const pkg = await readPackageJson();
      expect(pkg.files).toContain('dist');

      const missing: string[] = [];
      for (const [subpath, conditions] of Object.entries(pkg.exports)) {
        for (const [condition, target] of Object.entries(conditions)) {
          if (!existsSync(toPackedPath(target))) {
            missing.push(`${subpath} (${condition}) -> ${target}`);
          }
        }
      }
      expect(missing).toEqual([]);

      // Build a scratch package directory (package.json + files[]) so `npm
      // pack --dry-run` proves the real packed tarball would include every
      // exports target, without ever touching the repo's real `dist/`.
      const shadowDir = await mkdtemp(join(tmpdir(), 'browser-pilot-pack-'));
      try {
        await cp(resolve(REPO_ROOT, 'package.json'), join(shadowDir, 'package.json'));
        for (const file of pkg.files) {
          if (file === 'dist') {
            await mkdir(join(shadowDir, 'dist'), { recursive: true });
            await cp(PACKED_OUT_DIR, join(shadowDir, 'dist'), { recursive: true });
            continue;
          }
          const source = resolve(REPO_ROOT, file);
          if (existsSync(source)) {
            await cp(source, join(shadowDir, file), { recursive: true });
          }
        }

        const pack = Bun.spawnSync(['npm', 'pack', '--dry-run', '--json', '--ignore-scripts'], {
          cwd: shadowDir,
        });
        expect(pack.exitCode).toBe(0);
        const parsed = JSON.parse(pack.stdout.toString()) as Array<{
          files: Array<{ path: string }>;
        }>;
        const packedPaths = new Set(parsed[0]!.files.map((file) => file.path));
        const notPacked: string[] = [];
        for (const conditions of Object.values(pkg.exports)) {
          for (const target of Object.values(conditions)) {
            const normalized = target.replace(/^\.\//, '');
            if (!packedPaths.has(normalized)) notPacked.push(normalized);
          }
        }
        expect(notPacked).toEqual([]);
      } finally {
        await rm(shadowDir, { recursive: true, force: true });
      }

      // The built core entry must be importable and expose the contract surface.
      const core = (await import(join(PACKED_OUT_DIR, 'core/index.mjs'))) as Record<
        string,
        unknown
      >;
      expect(typeof core['CapabilityError']).toBe('function');
      expect(typeof core['createProvider']).toBe('function');
      expect(typeof core['Browser']).toBe('function');
      expect(typeof core['connectCore']).toBe('function');

      const nodeAdapter = (await import(join(PACKED_OUT_DIR, 'adapters/node/index.mjs'))) as Record<
        string,
        unknown
      >;
      expect(typeof nodeAdapter['InProcessSessionOwner']).toBe('function');
      expect(typeof nodeAdapter['loadCookieStateFile']).toBe('function');
      expect(typeof nodeAdapter['resolveCookieStateRef']).toBe('function');
      expect(typeof nodeAdapter['saveCookieStateFile']).toBe('function');

      const rootEntry = (await import(join(PACKED_OUT_DIR, 'index.mjs'))) as Record<
        string,
        unknown
      >;
      expect(typeof rootEntry['parseCookieState']).toBe('function');
      expect(typeof rootEntry['serializeCookieState']).toBe('function');
      expect(typeof rootEntry['captureCookieState']).toBe('function');
      expect(typeof rootEntry['restoreCookieState']).toBe('function');
      expect(typeof rootEntry['CookieStateError']).toBe('function');
      expect(typeof core['parseCookieState']).toBe('function');
      expect(typeof core['serializeCookieState']).toBe('function');
      expect(typeof core['captureCookieState']).toBe('function');
      expect(typeof core['restoreCookieState']).toBe('function');
      expect(typeof core['CookieStateError']).toBe('function');

      const memoryAdapter = (await import(
        join(PACKED_OUT_DIR, 'adapters/memory/index.mjs')
      )) as Record<string, unknown>;
      expect(typeof memoryAdapter['FakeClock']).toBe('function');
      expect(typeof memoryAdapter['MemorySessionOwner']).toBe('function');

      const shell = (await import(join(PACKED_OUT_DIR, 'shell/index.mjs'))) as Record<
        string,
        unknown
      >;
      expect(typeof shell['runBp']).toBe('function');
      expect(shell['CapabilityError']).toBe(core['CapabilityError']);

      const justBash = (await import(join(PACKED_OUT_DIR, 'just-bash/index.mjs'))) as Record<
        string,
        unknown
      >;
      expect(typeof justBash['registerBrowserPilotCommands']).toBe('function');
      expect(justBash['CapabilityError']).toBe(core['CapabilityError']);
    },
    BUILD_TIMEOUT_MS
  );
});
