/**
 * Fitness: stored-session commands must use the shared attachment path.
 *
 * A direct CDP connect in a command can silently bypass a healthy daemon and
 * recreate the repeated permission-prompt bug. The connect service and the
 * dedicated local bootstrap are the only allowed direct-connection owners.
 */
import { expect, test } from 'bun:test';

test('CLI commands do not import the direct connect helper', async () => {
  const glob = new Bun.Glob('src/cli/commands/*.ts');
  const violations: string[] = [];

  for await (const file of glob.scan('.')) {
    if (file === 'src/cli/commands/connect.ts') continue;
    const content = await Bun.file(file).text();
    if (/import\s*\{[^}]*\bconnect\b[^}]*\}\s*from\s*['"]\.\.\/\.\.\/index\.ts['"]/.test(content)) {
      violations.push(file);
    }
    if (/\bconnect\s*\(/.test(content) && !file.endsWith('connect-service.ts')) {
      // This second guard catches a future local helper even if it changes its
      // import shape. `connect.ts` is excluded above; command-local direct
      // calls are never allowed.
      violations.push(`${file}: direct connect() call`);
    }
  }

  expect(violations).toEqual([]);
});
