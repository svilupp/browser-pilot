/**
 * Fitness: Dangerous steps must never be auto-retried
 *
 * The executor must respect step.dangerous — when a dangerous step
 * has an ambiguous outcome, it must not be retried automatically.
 * This prevents destructive actions (e.g. "Place Order") from
 * being executed multiple times.
 */
import { expect, test } from 'bun:test';

test('executor respects dangerous flag — no auto-retry on dangerous steps', async () => {
  const content = await Bun.file('src/actions/executor.ts').text();

  // The executor must reference step.dangerous to gate retry behavior
  expect(content).toContain('step.dangerous');

  // Should have logic that breaks out of retry loop for dangerous steps
  // (the actual pattern is: if (step.dangerous) { ... break; })
  expect(content).toMatch(/dangerous[\s\S]{0,200}break/);
});

test('conditions module marks dangerous outcomes as unsafe to retry', async () => {
  const content = await Bun.file('src/actions/conditions.ts').text();

  // evaluateOutcome must use the dangerous flag to set retrySafe = false
  expect(content).toContain('retrySafe: !dangerous');
});

test('no code bypasses dangerous flag via override', async () => {
  const glob = new Bun.Glob('src/**/*.ts');
  const violations: string[] = [];

  for await (const file of glob.scan('.')) {
    const content = await Bun.file(file).text();

    // Look for patterns that force dangerous to false
    if (/dangerous\s*[:=]\s*false\b/.test(content)) {
      // Default parameter destructuring `dangerous = false` is expected in these files
      if (file === 'src/actions/conditions.ts') continue;
      if (file === 'src/browser/safe-submit.ts') continue;
      violations.push(`${file}: overrides dangerous flag to false`);
    }
  }

  expect(violations).toEqual([]);
});
