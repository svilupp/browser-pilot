/**
 * Fitness: No console.* in library code
 *
 * Library code should use the trace module for output.
 * Allowed: src/cli/, src/daemon/, src/trace/
 *
 * Known violations are allowlisted — they are pre-existing and should
 * be migrated to the trace module. Remove entries as they're fixed.
 */
import { expect, test } from 'bun:test';

const ALLOWED_DIRS = ['src/cli/', 'src/daemon/', 'src/trace/'];

// Pre-existing violations — these files have console.* calls that predate this fitness test.
// Note: src/audio/*.ts uses console.* in injected browser scripts (runs in-page, not in Node).
const KNOWN_VIOLATIONS = new Set([
  'src/audio/output.ts',
  'src/audio/input.ts',
  'src/browser/browser.ts',
  'src/browser/page.ts',
  'src/network/interceptor.ts',
  'src/cdp/client.ts',
]);

test('no new console.* in library code outside allowed modules', async () => {
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
      // Skip string content (injected JS scripts)
      if (trimmed.startsWith("'") || trimmed.startsWith('"') || trimmed.startsWith('`')) continue;

      if (/\bconsole\.(log|warn|error|info|debug|trace)\b/.test(trimmed)) {
        violations.push(`${file}:${i + 1}: ${trimmed.trim()}`);
      }
    }
  }

  expect(violations).toEqual([]);
});
