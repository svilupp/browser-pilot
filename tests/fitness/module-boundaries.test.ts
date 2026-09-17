/**
 * Fitness: Module boundary enforcement
 *
 * Ensures internal layer boundaries are respected:
 * - CDP layer must not import browser/cli/actions
 * - Wait layer must not import cli/daemon
 * - Actions must not import cli/daemon
 * - Provider types must not import concrete providers
 */
import { expect, test } from 'bun:test';

const BOUNDARY_RULES = [
  {
    from: 'src/cdp/',
    mustNotImport: ['src/browser/', 'src/cli/', 'src/actions/'],
  },
  { from: 'src/wait/', mustNotImport: ['src/cli/', 'src/daemon/'] },
  {
    from: 'src/providers/types.ts',
    mustNotImport: ['src/providers/browserbase', 'src/providers/browserless'],
  },
  { from: 'src/actions/', mustNotImport: ['src/cli/', 'src/daemon/'] },
  {
    from: 'src/auth/',
    mustNotImport: ['src/cli/', 'src/adapters/', 'src/daemon/'],
  },
];

for (const rule of BOUNDARY_RULES) {
  test(`${rule.from} must not import ${rule.mustNotImport.join(', ')}`, async () => {
    const pattern = rule.from.endsWith('.ts') ? rule.from : `${rule.from}**/*.ts`;
    const glob = new Bun.Glob(pattern);
    const violations: string[] = [];

    for await (const file of glob.scan('.')) {
      const content = await Bun.file(file).text();
      for (const forbidden of rule.mustNotImport) {
        // Match relative imports that resolve to the forbidden path
        const segment = forbidden.replace('src/', '');
        const re = new RegExp(`from\\s+['"]\\..*${segment}`, 'g');
        if (re.test(content)) {
          violations.push(`${file} imports from ${forbidden}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
}

test('src/auth/** must not import node:* built-ins', async () => {
  const glob = new Bun.Glob('src/auth/**/*.ts');
  const violations: string[] = [];

  for await (const file of glob.scan('.')) {
    const content = await Bun.file(file).text();
    const re = /from\s+['"]node:/g;
    if (re.test(content)) {
      violations.push(`${file} imports a node:* built-in`);
    }
  }

  expect(violations).toEqual([]);
});
