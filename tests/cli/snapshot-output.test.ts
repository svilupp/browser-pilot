/**
 * CLI snapshot output tests
 *
 * Tests for snapshot output formatting:
 * - Pretty mode truncates arrays
 * - JSON mode shows full data
 *
 * Pain point: "When using bp exec with snapshot action, the full snapshot
 * output isn't shown in default output mode."
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { withRetry } from '../utils/retry';
import { generateSessionName, getBaseUrl, getWebSocketUrl, runCLI, setup, teardown } from './setup';

describe('CLI Snapshot Output', () => {
  beforeAll(setup);
  afterAll(teardown);

  describe('exec with snapshot action', () => {
    const SESSION_NAME = generateSessionName();

    test('JSON output should include full snapshot data', async () => {
      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create session
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', SESSION_NAME]);

        // Navigate first
        await runCLI([
          'exec',
          '-s',
          SESSION_NAME,
          JSON.stringify({ action: 'goto', url: `${baseUrl}/form.html` }),
        ]);

        // Execute snapshot with JSON output
        const result = await runCLI([
          'exec',
          '-s',
          SESSION_NAME,
          '-o',
          'json',
          JSON.stringify({ action: 'snapshot' }),
        ]);

        expect(result.exitCode).toBe(0);

        const json = result.json as {
          success: boolean;
          steps: Array<{
            action: string;
            result?: {
              url?: string;
              title?: string;
              accessibilityTree?: unknown[];
              interactiveElements?: unknown[];
              text?: string;
            };
          }>;
        };

        expect(json.success).toBe(true);
        expect(json.steps).toHaveLength(1);
        expect(json.steps[0]!.action).toBe('snapshot');

        // Verify full snapshot data is present
        const snapshot = json.steps[0]!.result;
        expect(snapshot).toBeDefined();
        expect(snapshot?.url).toContain('form.html');
        expect(snapshot?.title).toBeDefined();

        // These should be full arrays, not truncated
        expect(Array.isArray(snapshot?.accessibilityTree)).toBe(true);
        expect(snapshot?.accessibilityTree?.length ?? 0).toBeGreaterThan(0);

        expect(Array.isArray(snapshot?.interactiveElements)).toBe(true);
        expect(snapshot?.interactiveElements?.length ?? 0).toBeGreaterThan(0);

        expect(typeof snapshot?.text).toBe('string');
        expect(snapshot?.text?.length ?? 0).toBeGreaterThan(0);

        // Cleanup
        await runCLI(['close', '-s', SESSION_NAME]).catch(() => {});
      });
    }, 60000);

    test('pretty output should truncate arrays to [N items]', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create session
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

        // Navigate first
        await runCLI([
          'exec',
          '-s',
          sessionName,
          JSON.stringify({ action: 'goto', url: `${baseUrl}/form.html` }),
        ]);

        // Execute snapshot with pretty output (default)
        const result = await runCLI([
          'exec',
          '-s',
          sessionName,
          JSON.stringify({ action: 'snapshot' }),
        ]);

        expect(result.exitCode).toBe(0);

        // Pretty output should show array counts, not full arrays
        expect(result.stdout).toMatch(/steps: \[\d+ items?\]/);

        // Cleanup
        await runCLI(['close', '-s', sessionName]).catch(() => {});
      });
    }, 60000);
  });

  describe('bp snapshot command', () => {
    test('should output full snapshot in JSON mode', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create session
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

        // Navigate first
        await runCLI([
          'exec',
          '-s',
          sessionName,
          JSON.stringify({ action: 'goto', url: `${baseUrl}/basic.html` }),
        ]);

        // Take snapshot with JSON output
        const result = await runCLI(['snapshot', '-s', sessionName, '-o', 'json']);

        expect(result.exitCode).toBe(0);

        const json = result.json as {
          url?: string;
          accessibilityTree?: unknown[];
          interactiveElements?: unknown[];
          text?: string;
        };

        // Verify full data
        expect(json.url).toContain('basic.html');
        expect(Array.isArray(json.accessibilityTree)).toBe(true);
        expect(Array.isArray(json.interactiveElements)).toBe(true);
        expect(typeof json.text).toBe('string');

        // Cleanup
        await runCLI(['close', '-s', sessionName]).catch(() => {});
      });
    }, 60000);

    test('--format text should show readable accessibility tree', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create session
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

        // Navigate first
        await runCLI([
          'exec',
          '-s',
          sessionName,
          JSON.stringify({ action: 'goto', url: `${baseUrl}/form.html` }),
        ]);

        // Take snapshot with text format
        const result = await runCLI(['snapshot', '-s', sessionName, '--format', 'text']);

        expect(result.exitCode).toBe(0);

        // Text format should include element refs
        expect(result.stdout).toMatch(/\[ref=e\d+\]/);

        // Should include form elements
        expect(result.stdout).toContain('Contact Form');

        // Cleanup
        await runCLI(['close', '-s', sessionName]).catch(() => {});
      });
    }, 60000);

    test('--format interactive should list only interactive elements', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create session
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

        // Navigate first
        await runCLI([
          'exec',
          '-s',
          sessionName,
          JSON.stringify({ action: 'goto', url: `${baseUrl}/form.html` }),
        ]);

        // Take snapshot with interactive format
        const result = await runCLI([
          'snapshot',
          '-s',
          sessionName,
          '--format',
          'interactive',
          '-o',
          'json',
        ]);

        expect(result.exitCode).toBe(0);

        // Should be an array of interactive elements
        const elements = result.json as Array<{
          ref: string;
          role: string;
          name?: string;
        }>;

        expect(Array.isArray(elements)).toBe(true);
        expect(elements.length).toBeGreaterThan(0);

        // Each element should have ref and role
        for (const el of elements) {
          expect(el.ref).toMatch(/^e\d+$/);
          expect(typeof el.role).toBe('string');
        }

        // Should include form inputs
        const hasInput = elements.some((el) => el.role === 'textbox' || el.role === 'button');
        expect(hasInput).toBe(true);

        // Cleanup
        await runCLI(['close', '-s', sessionName]).catch(() => {});
      });
    }, 60000);
  });

  describe('snapshot via ref selectors', () => {
    test('exec snapshot should cache refs for subsequent commands', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create session
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

        // Navigate and snapshot
        await runCLI([
          'exec',
          '-s',
          sessionName,
          '-o',
          'json',
          JSON.stringify([{ action: 'goto', url: `${baseUrl}/form.html` }, { action: 'snapshot' }]),
        ]);

        // Use ref selector in next command
        const result = await runCLI([
          'exec',
          '-s',
          sessionName,
          '-o',
          'json',
          JSON.stringify({ action: 'fill', selector: 'ref:e1', value: 'test' }),
        ]);

        // Should either succeed or fail with element not found (not invalid ref error)
        if (result.exitCode !== 0) {
          expect(result.stderr).not.toContain('Invalid ref');
        }

        // Cleanup
        await runCLI(['close', '-s', sessionName]).catch(() => {});
      });
    }, 60000);
  });
});
