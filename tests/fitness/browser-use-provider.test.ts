/**
 * Fitness: Browser Use provider architectural constraints
 */
import { expect, test } from 'bun:test';

test('browser-use provider is exported from src/index.ts', async () => {
  const content = await Bun.file('src/index.ts').text();
  expect(content).toContain('BrowserUseProvider');
  expect(content).toContain('BrowserUseOptions');
});

test('browser-use is in ConnectOptions provider union', async () => {
  const content = await Bun.file('src/providers/types.ts').text();
  expect(content).toContain("'browser-use'");
});

test('browser-use is in ProviderType union in session.ts', async () => {
  const content = await Bun.file('src/cli/session.ts').text();
  expect(content).toContain("'browser-use'");
});

test('createProvider handles browser-use case', async () => {
  const content = await Bun.file('src/providers/index.ts').text();
  expect(content).toContain("case 'browser-use':");
});

test('BrowserUseProvider uses getEnv() not process.env', async () => {
  const content = await Bun.file('src/providers/browser-use.ts').text();
  // Should not contain raw process.env
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    expect(trimmed).not.toMatch(/\bprocess\.env\b/);
  }
});

test('BrowserUseProvider has zero production dependencies', async () => {
  const content = await Bun.file('src/providers/browser-use.ts').text();
  // Should only import from local modules (starting with . or ..)
  const importLines = content.split('\n').filter((l) => l.trimStart().startsWith('import '));
  for (const line of importLines) {
    const match = line.match(/from\s+['"]([^'"]+)['"]/);
    if (match) {
      expect(match[1]).toMatch(/^\.\//);
    }
  }
});
