/**
 * Fitness: `browser-pilot/core` portability
 *
 * Statically walks the import graph reachable from `src/core/index.ts`
 * (resolving relative `.ts` imports, including type-only and literal dynamic
 * imports) and asserts that no reachable file:
 *  - imports `node:*`, `bun:*`, or `chrome-launcher`
 *  - lives under `src/cli/` or `src/daemon/`
 *  - is `src/providers/local-discovery.ts` or `src/runtime/env.ts`
 *  - contains a raw `process.env` token (secrets must come through SecretsPort)
 *
 * Also bundles the core entry with `Bun.build({ target: 'browser' })` and
 * asserts success. Note the bundle check alone is weak (Bun shims node
 * built-ins for browser targets), so the static walk is the real gate.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const CORE_ENTRY = 'src/core/index.ts';
const REPO_ROOT = resolve(import.meta.dir, '../..');

const FORBIDDEN_FILE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^src\/cli\//, reason: 'CLI code' },
  { pattern: /^src\/daemon\//, reason: 'daemon code' },
  {
    pattern: /^src\/providers\/local-discovery\.ts$/,
    reason: 'local Chrome discovery (Node-only)',
  },
  { pattern: /^src\/runtime\/env\.ts$/, reason: 'ambient env access (use SecretsPort)' },
  { pattern: /^src\/artifacts\/node\.ts$/, reason: 'Node artifact sink (adapter-only)' },
];

const FORBIDDEN_SPECIFIER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^node:/, label: 'node:* import' },
  { pattern: /^bun(:|$)/, label: 'bun:* import' },
  { pattern: /^chrome-launcher$/, label: 'chrome-launcher import' },
];

/**
 * Extract import/export specifiers, including literal dynamic imports.
 * Returns `{ specifier, typeOnly }`; `typeOnly` is true for `import type`
 * statements (used to allow `just-bash`'s type-only import from `src/just-bash/**`).
 */
function extractSpecifiers(source: string): Array<{ specifier: string; typeOnly: boolean }> {
  const specifiers: Array<{ specifier: string; typeOnly: boolean }> = [];
  const staticRe = /(?:^|\n)\s*(import|export)\b([^'"\n]*?)from\s*['"]([^'"]+)['"]/g;
  const bareRe = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match: RegExpExecArray | null;
  match = staticRe.exec(source);
  while (match !== null) {
    const clause = match[2] ?? '';
    const typeOnly = /^\s*type\b/.test(clause);
    specifiers.push({ specifier: match[3]!, typeOnly });
    match = staticRe.exec(source);
  }
  for (const re of [bareRe, dynamicRe]) {
    match = re.exec(source);
    while (match !== null) {
      specifiers.push({ specifier: match[1]!, typeOnly: false });
      match = re.exec(source);
    }
  }
  return specifiers;
}

function walkGraph(
  entry: string,
  options: { allowTypeOnlySpecifiers?: string[] } = {}
): { files: string[]; violations: string[] } {
  const seen = new Set<string>();
  const violations: string[] = [];
  const queue = [resolve(REPO_ROOT, entry)];
  const allowTypeOnly = new Set(options.allowTypeOnlySpecifiers ?? []);

  while (queue.length > 0) {
    const absolute = queue.pop()!;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const relPath = relative(REPO_ROOT, absolute);

    for (const { pattern, reason } of FORBIDDEN_FILE_PATTERNS) {
      if (pattern.test(relPath)) {
        violations.push(`${relPath}: forbidden in core graph (${reason})`);
      }
    }

    const source = readFileSync(absolute, 'utf8');

    // Raw process.env token check (skip comment lines).
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      if (/\bprocess\.env\b/.test(trimmed)) {
        violations.push(`${relPath}:${i + 1}: raw process.env token in core graph`);
      }
    }

    for (const { specifier, typeOnly } of extractSpecifiers(source)) {
      if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(absolute), specifier));
        continue;
      }
      if (typeOnly && allowTypeOnly.has(specifier)) continue;
      for (const { pattern, label } of FORBIDDEN_SPECIFIER_PATTERNS) {
        if (pattern.test(specifier)) {
          violations.push(`${relPath}: ${label} ('${specifier}')`);
        }
      }
    }
  }

  return { files: [...seen].map((file) => relative(REPO_ROOT, file)), violations };
}

test('core import graph is portable (no node:*, chrome-launcher, cli/daemon, env)', () => {
  const { files, violations } = walkGraph(CORE_ENTRY);
  // Sanity: the walker actually traversed the graph.
  expect(files.length).toBeGreaterThan(20);
  expect(files).toContain('src/browser/browser.ts');
  expect(violations).toEqual([]);
});

test('adapters/memory import graph is portable too', () => {
  const { violations } = walkGraph('src/adapters/memory/index.ts');
  expect(violations).toEqual([]);
});

test('just-bash import graph is portable (type-only `just-bash` import allowed)', () => {
  const { files, violations } = walkGraph('src/just-bash/index.ts', {
    allowTypeOnlySpecifiers: ['just-bash'],
  });
  expect(files.length).toBeGreaterThan(3);
  expect(violations).toEqual([]);
});

test('artifacts/memory import graph is portable', () => {
  const { violations } = walkGraph('src/artifacts/memory.ts');
  expect(violations).toEqual([]);
});

test('core entry bundles for a browser target', async () => {
  const result = await Bun.build({
    entrypoints: [resolve(REPO_ROOT, CORE_ENTRY)],
    target: 'browser',
    throw: false,
  });
  const logs = result.logs.map((log) => String(log.message));
  expect({ success: result.success, logs }).toEqual({ success: true, logs: [] });
});
