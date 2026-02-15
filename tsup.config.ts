import { defineConfig } from 'tsup';

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
    outExtension() {
      return { js: '.mjs' };
    },
  },
]);
