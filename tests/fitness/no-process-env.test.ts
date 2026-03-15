/**
 * Fitness: No raw process.env outside allowed modules
 *
 * Library code should use src/runtime/env.ts for env access.
 * Allowed: src/cli/, src/daemon/, src/runtime/
 *
 * Known violations are allowlisted to prevent regressions while
 * they are migrated to src/runtime/env.ts.
 */
import { expect, test } from 'bun:test';

const ALLOWED_DIRS = ['src/cli/', 'src/daemon/', 'src/runtime/'];

// Pre-existing violations to migrate — remove entries as they're fixed
const KNOWN_VIOLATIONS = new Set(['src/audio/transcribe.ts', 'src/providers/local-discovery.ts']);

test('no new raw process.env in library code outside allowed modules', async () => {
  const glob = new Bun.Glob('src/**/*.ts');
  const violations: string[] = [];

  for await (const file of glob.scan('.')) {
    if (ALLOWED_DIRS.some((d) => file.startsWith(d))) continue;
    if (KNOWN_VIOLATIONS.has(file)) continue;

    const content = await Bun.file(file).text();
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trimStart();
      // Skip comments
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

      if (/\bprocess\.env\b/.test(trimmed)) {
        violations.push(`${file}:${i + 1}: raw process.env access`);
      }
    }
  }

  expect(violations).toEqual([]);
});
