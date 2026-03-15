/**
 * Fitness: Runtime portability for core modules
 *
 * Core browser/CDP/wait modules must not use Node-only APIs so they
 * remain portable to Cloudflare Workers and other non-Node runtimes.
 */
import { expect, test } from 'bun:test';

// Core modules that must be runtime-portable (no Node-only APIs)
const PORTABLE_MODULES = [
  'src/browser/page.ts',
  'src/browser/browser.ts',
  'src/browser/actionability.ts',
  'src/browser/types.ts',
  'src/browser/snapshot-diff.ts',
  'src/browser/keyboard.ts',
  'src/cdp/client.ts',
  'src/cdp/protocol.ts',
  'src/wait/strategies.ts',
  'src/providers/types.ts',
  'src/actions/types.ts',
  'src/actions/conditions.ts',
];

// Node-only APIs that should not appear in portable modules
const NODE_ONLY_PATTERNS = [
  { pattern: /\bfrom\s+['"]node:fs['"]/, label: 'node:fs' },
  { pattern: /\bfrom\s+['"]node:path['"]/, label: 'node:path' },
  { pattern: /\bfrom\s+['"]node:child_process['"]/, label: 'node:child_process' },
  { pattern: /\bfrom\s+['"]node:os['"]/, label: 'node:os' },
  { pattern: /\brequire\s*\(\s*['"]fs['"]\s*\)/, label: 'require("fs")' },
  { pattern: /\bprocess\.cwd\(\)/, label: 'process.cwd()' },
];

test('portable core modules do not import Node-only APIs', async () => {
  const violations: string[] = [];

  for (const relPath of PORTABLE_MODULES) {
    const file = Bun.file(relPath);
    if (!(await file.exists())) continue;

    const content = await file.text();

    for (const { pattern, label } of NODE_ONLY_PATTERNS) {
      if (pattern.test(content)) {
        violations.push(`${relPath}: uses Node-only API (${label})`);
      }
    }
  }

  expect(violations).toEqual([]);
});
