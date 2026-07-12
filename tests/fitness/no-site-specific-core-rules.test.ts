/**
 * Fitness: No hardcoded site names or domains in core source
 *
 * Ensures src/ stays site-agnostic — no vertical-specific heuristics
 * or hardcoded domains that would couple the library to specific customers.
 */
import { expect, test } from 'bun:test';

// Patterns that indicate site-specific logic
const FORBIDDEN = [
  /salesforce\.com/i,
  /workday\.com/i,
  /servicenow\.com/i,
  /zendesk\.com/i,
  /\bjira\b/i,
  /\bconfluence\b/i,
  /\bhubspot\.com/i,
];

// Files/directories where site references are acceptable (examples, docs, fixtures)
const ALLOWED_PATHS = /\/(fixtures|test|examples|docs)\//;

test('no hardcoded site names or domains in core source', async () => {
  const glob = new Bun.Glob('src/**/*.ts');
  const violations: string[] = [];

  for await (const file of glob.scan('.')) {
    if (ALLOWED_PATHS.test(`/${file}`)) continue;

    const content = await Bun.file(file).text();
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trimStart();
      // Skip comments — rationale annotations are fine
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

      for (const pattern of FORBIDDEN) {
        if (pattern.test(trimmed)) {
          violations.push(`${file}:${i + 1}: matches ${pattern}`);
        }
      }
    }
  }

  expect(violations).toEqual([]);
});
