/**
 * Fitness: Export surface governance
 *
 * Verifies src/index.ts doesn't export CLI, daemon, or test internals.
 */
import { expect, test } from 'bun:test';

test('src/index.ts does not export CLI/daemon/test internals', async () => {
  const content = await Bun.file('src/index.ts').text();
  const forbidden = ['cli/', 'daemon/', 'tests/', 'runtime/'];
  // `runtime/env.ts` is an intentional exception: it exposes the
  // setEnvOverrides/clearEnvOverrides/withEnv injection hook, which is public
  // API needed to inject credentials in runtimes without process.env (e.g. a
  // Cloudflare Worker). Other runtime/ internals (clock, provenance internals,
  // branded types helpers, etc.) remain non-exported.
  const allowedExceptions = ["'./runtime/env.ts'", '"./runtime/env.ts"'];
  const violations: string[] = [];

  for (const mod of forbidden) {
    const hasMatch = content.includes(`'./${mod}`) || content.includes(`"./${mod}`);
    if (!hasMatch) continue;

    // Substring check catches both static `from './mod/x'` exports AND
    // dynamic `import('./mod/x')` calls; a regex anchored to `from` would
    // silently miss the latter.
    const re = new RegExp(`['"]\\./${mod}[^'"]*['"]`, 'g');
    const matches = content.match(re) ?? [];
    const unexpected = matches.filter((m) => !allowedExceptions.includes(m));
    if (unexpected.length > 0) {
      violations.push(`src/index.ts exports from ./${mod}: ${unexpected.join(', ')}`);
    }
  }

  expect(violations).toEqual([]);
});
