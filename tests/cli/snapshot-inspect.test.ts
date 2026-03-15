/**
 * CLI snapshot inspect tests
 *
 * Tests for bp snapshot --inspect functionality
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { withRetry } from '../utils/retry.ts';
import {
  generateSessionName,
  getBaseUrl,
  getWebSocketUrl,
  runCLI,
  setup,
  teardown,
} from './setup.ts';

describe.skipIf(!!process.env['CI'])('CLI Snapshot Inspect', () => {
  beforeAll(setup);
  afterAll(teardown);

  describe('--inspect flag', () => {
    test('injects overlay and shows message', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create session
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

        // Navigate
        await runCLI([
          'exec',
          '-s',
          sessionName,
          JSON.stringify({ action: 'goto', url: `${baseUrl}/form.html` }),
        ]);

        // Run snapshot with --inspect and --keep (so it doesn't wait 10 seconds)
        const result = await runCLI(['snapshot', '-s', sessionName, '--inspect', '--keep']);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Overlay injected');
        expect(result.stdout).toContain('visible');

        // Cleanup
        await runCLI(['close', '-s', sessionName]).catch(() => {});
      });
    }, 60000);

    test('--keep prevents auto-cleanup message', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create session
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

        // Navigate
        await runCLI([
          'exec',
          '-s',
          sessionName,
          JSON.stringify({ action: 'goto', url: `${baseUrl}/basic.html` }),
        ]);

        // Run snapshot with --inspect and --keep
        const result = await runCLI(['snapshot', '-s', sessionName, '--inspect', '--keep']);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Overlay will remain visible');
        expect(result.stdout).not.toContain('will be removed in 10 seconds');

        // Cleanup
        await runCLI(['close', '-s', sessionName]).catch(() => {});
      });
    }, 60000);

    // Note: Testing auto-cleanup (without --keep) would require waiting 10 seconds.
    // The --keep flag test already covers the main overlay injection behavior.
  });

  describe('--inspect with output formats', () => {
    test('--inspect works with --format text', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create session
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

        // Navigate
        await runCLI([
          'exec',
          '-s',
          sessionName,
          JSON.stringify({ action: 'goto', url: `${baseUrl}/form.html` }),
        ]);

        // Run snapshot with --inspect, --keep, and --format text
        const result = await runCLI([
          'snapshot',
          '-s',
          sessionName,
          '--inspect',
          '--keep',
          '--format',
          'text',
        ]);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Overlay injected');
        // Text format should include refs
        expect(result.stdout).toMatch(/ref:e\d+/);

        // Cleanup
        await runCLI(['close', '-s', sessionName]).catch(() => {});
      });
    }, 60000);
  });
});
