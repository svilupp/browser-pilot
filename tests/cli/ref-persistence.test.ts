/**
 * CLI ref persistence tests
 *
 * Tests verifying that refs persist across separate CLI invocations
 * when a snapshot has populated the session ref cache.
 *
 * This documents the behavior that:
 * - `bp snapshot` (standalone) shows refs and caches them for the session+URL
 * - `bp exec` with `ref:eX` in a separate call succeeds when the URL is unchanged
 * - Refs are not reused after navigation (URL mismatch)
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { withRetry } from '../utils/retry';
import { generateSessionName, getBaseUrl, getWebSocketUrl, runCLI, setup, teardown } from './setup';

interface ElementRef {
  role: string;
  name: string;
  ref: string;
}

/**
 * Parse snapshot JSON result to extract element refs with their roles.
 */
function parseRefsFromSnapshotJson(
  tree: Array<{ role?: string; name?: string; ref?: string; children?: unknown[] }>
): ElementRef[] {
  const refs: ElementRef[] = [];

  function walk(
    nodes: Array<{ role?: string; name?: string; ref?: string; children?: unknown[] }>
  ) {
    for (const node of nodes) {
      if (node.ref && node.role && node.name) {
        refs.push({ role: node.role, name: node.name, ref: node.ref });
      }
      if (node.children && Array.isArray(node.children)) {
        walk(
          node.children as Array<{
            role?: string;
            name?: string;
            ref?: string;
            children?: unknown[];
          }>
        );
      }
    }
  }

  walk(tree);
  return refs;
}

/**
 * Find a ref by role and partial name match.
 * This is more precise than name-only matching.
 */
function findRefByRoleAndName(
  refs: ElementRef[],
  role: string,
  partialName: string
): string | undefined {
  const lowerPartial = partialName.toLowerCase();
  const match = refs.find((r) => r.role === role && r.name.toLowerCase().includes(lowerPartial));
  return match?.ref;
}

describe('CLI Ref Persistence (Cross-Exec Cache)', () => {
  beforeAll(setup);
  afterAll(teardown);

  const SESSION_NAME = generateSessionName();

  test('should create a session for ref persistence tests', async () => {
    await withRetry(async () => {
      const wsUrl = await getWebSocketUrl();

      const result = await runCLI([
        'connect',
        '--provider',
        'generic',
        '--url',
        wsUrl,
        '--name',
        SESSION_NAME,
        '-o',
        'json',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        success: true,
        sessionId: SESSION_NAME,
      });
    });
  }, 30000);

  test('refs persist across exec calls after snapshot in exec', async () => {
    await withRetry(async () => {
      const baseUrl = getBaseUrl();

      // Navigate + snapshot in one batch, capture snapshot output to get refs
      const setupResult = await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        JSON.stringify([{ action: 'goto', url: `${baseUrl}/form.html` }, { action: 'snapshot' }]),
      ]);

      expect(setupResult.exitCode).toBe(0);

      // Extract refs from the snapshot step result (use JSON tree, not text)
      const setupJson = setupResult.json as {
        success: boolean;
        steps?: Array<{
          success: boolean;
          result?: {
            accessibilityTree?: Array<{
              role?: string;
              name?: string;
              ref?: string;
              children?: unknown[];
            }>;
          };
        }>;
      };
      const tree = setupJson.steps?.[1]?.result?.accessibilityTree ?? [];
      const refs = parseRefsFromSnapshotJson(tree);

      // Find the textbox (not StaticText or InlineTextBox) for Name
      const nameRef = findRefByRoleAndName(refs, 'textbox', 'name');
      expect(nameRef).toBeDefined();

      // NOW test: ref usage in a NEW exec should work (cache)
      const result = await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        JSON.stringify([
          { action: 'fill', selector: `ref:${nameRef}`, value: 'Test User' }, // Use cached ref
        ]),
      ]);

      // This should succeed - refs from snapshot should work across exec calls
      const json = result.json as {
        success: boolean;
        steps?: Array<{ success: boolean; error?: string }>;
      };

      // Debug: show actual error if test fails
      if (!json.success) {
        console.log('DEBUG: refs test failed with:', JSON.stringify(json.steps, null, 2));
      }

      expect(result.exitCode).toBe(0);
      expect(json.success).toBe(true);
    });
  }, 60000);

  test('refs from standalone snapshot persist across exec calls', async () => {
    await withRetry(async () => {
      const baseUrl = getBaseUrl();

      // First: Navigate to page
      await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        JSON.stringify({ action: 'goto', url: `${baseUrl}/form.html` }),
      ]);

      // Second: Standalone snapshot to get refs (and populate cache)
      const setupResult = await runCLI(['snapshot', '-s', SESSION_NAME, '-o', 'json']);

      expect(setupResult.exitCode).toBe(0);

      // Extract the textbox ref from snapshot
      const setupJson = setupResult.json as {
        success: boolean;
        accessibilityTree?: Array<{
          role?: string;
          name?: string;
          ref?: string;
          children?: unknown[];
        }>;
      };
      const tree = setupJson.accessibilityTree ?? [];
      const refs = parseRefsFromSnapshotJson(tree);
      const nameRef = findRefByRoleAndName(refs, 'textbox', 'name');
      expect(nameRef).toBeDefined();

      // Third: Use ref from previous snapshot in NEW exec call
      const execResult = await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        JSON.stringify({
          action: 'fill',
          selector: `ref:${nameRef}`, // Ref from snapshot cache
          value: 'Should Work',
          timeout: 5000,
        }),
      ]);

      // Should succeed - ref cache should be hydrated for same URL
      const json = execResult.json as {
        success: boolean;
        steps?: Array<{ success: boolean; error?: string }>;
      };
      expect(json.success).toBe(true);
    });
  }, 60000);

  test('refs are not reused after navigation (URL mismatch)', async () => {
    await withRetry(async () => {
      const baseUrl = getBaseUrl();

      // Take snapshot to get refs + populate cache
      const setupResult = await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        JSON.stringify([{ action: 'goto', url: `${baseUrl}/form.html` }, { action: 'snapshot' }]),
      ]);

      expect(setupResult.exitCode).toBe(0);

      const setupJson = setupResult.json as {
        success: boolean;
        steps?: Array<{
          success: boolean;
          result?: {
            accessibilityTree?: Array<{
              role?: string;
              name?: string;
              ref?: string;
              children?: unknown[];
            }>;
          };
        }>;
      };
      const tree = setupJson.steps?.[1]?.result?.accessibilityTree ?? [];
      const refs = parseRefsFromSnapshotJson(tree);
      const nameRef = findRefByRoleAndName(refs, 'textbox', 'name');
      expect(nameRef).toBeDefined();

      // Navigate to a different URL without taking a new snapshot
      await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        JSON.stringify({ action: 'goto', url: `${baseUrl}/basic.html` }),
      ]);

      // Attempt to use old ref on new URL - should fail
      const execResult = await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        JSON.stringify({
          action: 'fill',
          selector: `ref:${nameRef}`,
          value: 'Should Fail',
          timeout: 2000,
        }),
      ]);

      const json = execResult.json as {
        success: boolean;
        steps?: Array<{ success: boolean; error?: string }>;
      };
      expect(json.success).toBe(false);
      const step = json.steps?.[0];
      expect(step?.success).toBe(false);
      expect(step?.error).toContain('not found');
    });
  }, 60000);

  test('refs with CSS fallback succeed despite fresh Page (graceful degradation)', async () => {
    await withRetry(async () => {
      const baseUrl = getBaseUrl();

      // Navigate via exec (fresh page state)
      await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        JSON.stringify({ action: 'goto', url: `${baseUrl}/form.html` }),
      ]);

      // Take standalone snapshot (to simulate workflow where user sees refs)
      await runCLI(['snapshot', '-s', SESSION_NAME, '--format', 'text']);

      // Use multi-selector with invalid ref first (will fail), CSS fallback (will succeed)
      const result = await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        JSON.stringify({
          action: 'fill',
          selector: ['ref:e999', '#name'], // Invalid ref, valid CSS fallback
          value: 'Fallback Works',
        }),
      ]);

      // Should succeed via CSS fallback
      // Note: selectorUsed reports the first selector in array (current limitation)
      expect(result.exitCode).toBe(0);
      const json = result.json as { success: boolean; steps?: Array<{ success: boolean }> };
      expect(json.success).toBe(true);
    });
  }, 60000);

  test('should close session', async () => {
    await withRetry(async () => {
      const result = await runCLI(['close', '-s', SESSION_NAME, '-o', 'json']);

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({ success: true });
    });
  }, 30000);
});
