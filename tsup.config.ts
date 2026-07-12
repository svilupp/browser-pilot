import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as {
  version: string;
};

function gitSourceHash(): string {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const trackedDiff = execFileSync('git', ['diff', '--no-ext-diff', '--binary', 'HEAD', '--'], {
      encoding: 'utf8',
    });
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .map((path) => `${path}\0${readFileSync(path)}`)
      .join('\0');
    return createHash('sha256').update(`${head}\0${trackedDiff}\0${untracked}`).digest('hex');
  } catch {
    return 'unknown';
  }
}

const sourceHash = gitSourceHash();
const buildHash = createHash('sha256')
  .update(`${packageJson.version}:${sourceHash}`)
  .digest('hex')
  .slice(0, 16);

const provenanceDefine = {
  __BP_PACKAGE_VERSION__: JSON.stringify(packageJson.version),
  __BP_GIT_SOURCE_HASH__: JSON.stringify(sourceHash),
  __BP_BUILD_HASH__: JSON.stringify(buildHash),
};

export default defineConfig([
  // Library entries — dual ESM + CJS
  {
    entry: {
      index: 'src/index.ts',
      cdp: 'src/cdp/index.ts',
      providers: 'src/providers/index.ts',
      browser: 'src/browser/index.ts',
      actions: 'src/actions/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    target: 'node18',
    define: provenanceDefine,
    outExtension({ format }) {
      return {
        js: format === 'esm' ? '.mjs' : '.cjs',
      };
    },
  },
  // CLI entry — ESM only (uses import.meta.main)
  {
    entry: {
      cli: 'src/cli/index.ts',
    },
    format: ['esm'],
    dts: true,
    target: 'node18',
    define: {
      ...provenanceDefine,
      __BP_CLI_VERSION__: JSON.stringify(packageJson.version),
    },
    outExtension() {
      return { js: '.mjs' };
    },
  },
]);
