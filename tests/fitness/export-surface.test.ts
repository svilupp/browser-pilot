/**
 * Fitness: Export surface governance
 *
 * Verifies src/index.ts doesn't export CLI, daemon, or test internals.
 */
import { expect, test } from 'bun:test';

test('src/index.ts does not export CLI/daemon/test internals', async () => {
  const content = await Bun.file('src/index.ts').text();
  const forbidden = ['cli/', 'daemon/', 'tests/', 'runtime/'];
  const violations: string[] = [];

  for (const mod of forbidden) {
    if (content.includes(`'./${mod}`) || content.includes(`"./${mod}`)) {
      violations.push(`src/index.ts exports from ${mod}`);
    }
    // Also check without leading ./
    const re = new RegExp(`from\\s+['"]\\./${mod}`, 'g');
    if (re.test(content)) {
      violations.push(`src/index.ts exports from ./${mod}`);
    }
  }

  expect(violations).toEqual([]);
});
