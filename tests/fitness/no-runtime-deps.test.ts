/**
 * Fitness: No runtime dependencies in src/
 *
 * Verifies the zero-dependency policy: src/ must not import packages
 * outside node: builtins and bun: builtins.
 */
import { expect, test } from 'bun:test';

const ALLOWED_PREFIXES = ['node:', 'bun:'];

test('no runtime dependencies in src/', async () => {
  const glob = new Bun.Glob('src/**/*.ts');
  const violations: string[] = [];

  for await (const file of glob.scan('.')) {
    const content = await Bun.file(file).text();
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trimStart();
      // Only check actual import/export-from statements at the top level
      if (!trimmed.startsWith('import ') && !trimmed.startsWith('export ')) continue;
      // Skip type-only imports
      if (trimmed.startsWith('import type ')) continue;

      const match = trimmed.match(/from\s+['"]([^./][^'"]+)['"]/);
      if (!match?.[1]) continue;

      const pkg = match[1];
      if (ALLOWED_PREFIXES.some((a) => pkg.startsWith(a))) continue;
      violations.push(`${file}: imports "${pkg}"`);
    }
  }

  expect(violations).toEqual([]);
});
