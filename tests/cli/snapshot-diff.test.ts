/**
 * CLI snapshot diff tests
 *
 * Tests for bp snapshot --diff functionality:
 * - Parses --diff flag and loads file
 * - Shows error when file not found
 * - Outputs JSON or pretty format
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PageSnapshot } from '../../src/browser/types';
import { withRetry } from '../utils/retry';
import { generateSessionName, getBaseUrl, getWebSocketUrl, runCLI, setup, teardown } from './setup';

describe('CLI Snapshot Diff', () => {
  beforeAll(setup);
  afterAll(teardown);

  describe('--diff flag parsing', () => {
    test('shows error when diff file does not exist', async () => {
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

        // Try to diff with non-existent file
        const result = await runCLI([
          'snapshot',
          '-s',
          sessionName,
          '--diff',
          '/nonexistent/file.json',
        ]);

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('not found');

        // Cleanup
        await runCLI(['close', '-s', sessionName]).catch(() => {});
      });
    }, 60000);

    test('--diff loads file and compares snapshots', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create a temporary file with a "before" snapshot
        const tmpDir = os.tmpdir();
        const beforeFile = path.join(tmpDir, `before-${Date.now()}.json`);

        const beforeSnapshot: PageSnapshot = {
          url: `${baseUrl}/basic.html`,
          title: 'Before Page',
          timestamp: new Date().toISOString(),
          accessibilityTree: [{ ref: 'e1', role: 'button', name: 'Old Button' }],
          interactiveElements: [],
          text: '',
        };

        fs.writeFileSync(beforeFile, JSON.stringify(beforeSnapshot));

        try {
          // Create session
          await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

          // Navigate to basic.html
          await runCLI([
            'exec',
            '-s',
            sessionName,
            JSON.stringify({ action: 'goto', url: `${baseUrl}/basic.html` }),
          ]);

          // Run diff
          const result = await runCLI(['snapshot', '-s', sessionName, '--diff', beforeFile]);

          expect(result.exitCode).toBe(0);
          // Should contain diff output (either changes or no changes)
          expect(result.stdout).toMatch(/Snapshot Diff:|Changes:|No changes detected/);

          // Cleanup
          await runCLI(['close', '-s', sessionName]).catch(() => {});
        } finally {
          // Clean up temp file
          fs.unlinkSync(beforeFile);
        }
      });
    }, 60000);

    test('--diff with --json outputs JSON format', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create a temporary file with a "before" snapshot
        const tmpDir = os.tmpdir();
        const beforeFile = path.join(tmpDir, `before-json-${Date.now()}.json`);

        const beforeSnapshot: PageSnapshot = {
          url: `${baseUrl}/form.html`,
          title: 'Before Form',
          timestamp: new Date().toISOString(),
          accessibilityTree: [],
          interactiveElements: [],
          text: '',
        };

        fs.writeFileSync(beforeFile, JSON.stringify(beforeSnapshot));

        try {
          // Create session
          await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

          // Navigate to form.html (different from before snapshot)
          await runCLI([
            'exec',
            '-s',
            sessionName,
            JSON.stringify({ action: 'goto', url: `${baseUrl}/form.html` }),
          ]);

          // Run diff with JSON output
          const result = await runCLI([
            'snapshot',
            '-s',
            sessionName,
            '--diff',
            beforeFile,
            '-o',
            'json',
          ]);

          expect(result.exitCode).toBe(0);

          // Parse JSON output
          const diff = result.json as {
            metadata: {
              before: { url: string };
              after: { url: string };
            };
            summary: {
              added: number;
              removed: number;
              changed: number;
            };
            changes: {
              added: unknown[];
              removed: unknown[];
              changed: unknown[];
            };
          };

          expect(diff.metadata).toBeDefined();
          expect(diff.metadata.before).toBeDefined();
          expect(diff.metadata.after).toBeDefined();
          expect(diff.summary).toBeDefined();
          expect(typeof diff.summary.added).toBe('number');
          expect(typeof diff.summary.removed).toBe('number');
          expect(typeof diff.summary.changed).toBe('number');
          expect(diff.changes).toBeDefined();
          expect(Array.isArray(diff.changes.added)).toBe(true);

          // Cleanup
          await runCLI(['close', '-s', sessionName]).catch(() => {});
        } finally {
          // Clean up temp file
          fs.unlinkSync(beforeFile);
        }
      });
    }, 60000);
  });

  describe('diff output formatting', () => {
    test('pretty output shows added elements with + prefix', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create a "before" snapshot with no elements
        const tmpDir = os.tmpdir();
        const beforeFile = path.join(tmpDir, `before-added-${Date.now()}.json`);

        const beforeSnapshot: PageSnapshot = {
          url: `${baseUrl}/form.html`,
          title: 'Empty Before',
          timestamp: new Date().toISOString(),
          accessibilityTree: [],
          interactiveElements: [],
          text: '',
        };

        fs.writeFileSync(beforeFile, JSON.stringify(beforeSnapshot));

        try {
          // Create session
          await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

          // Navigate to form.html which has elements
          await runCLI([
            'exec',
            '-s',
            sessionName,
            JSON.stringify({ action: 'goto', url: `${baseUrl}/form.html` }),
          ]);

          // Run diff (pretty output)
          const result = await runCLI(['snapshot', '-s', sessionName, '--diff', beforeFile]);

          expect(result.exitCode).toBe(0);
          // Should show added elements (form.html has many elements)
          expect(result.stdout).toContain('+');
          expect(result.stdout).toContain('new');

          // Cleanup
          await runCLI(['close', '-s', sessionName]).catch(() => {});
        } finally {
          fs.unlinkSync(beforeFile);
        }
      });
    }, 60000);

    test('pretty output shows summary with counts', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create "before" snapshot
        const tmpDir = os.tmpdir();
        const beforeFile = path.join(tmpDir, `before-summary-${Date.now()}.json`);

        const beforeSnapshot: PageSnapshot = {
          url: `${baseUrl}/basic.html`,
          title: 'Before',
          timestamp: new Date().toISOString(),
          accessibilityTree: [{ ref: 'e1', role: 'button', name: 'Will be removed' }],
          interactiveElements: [],
          text: '',
        };

        fs.writeFileSync(beforeFile, JSON.stringify(beforeSnapshot));

        try {
          // Create session
          await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

          // Navigate
          await runCLI([
            'exec',
            '-s',
            sessionName,
            JSON.stringify({ action: 'goto', url: `${baseUrl}/basic.html` }),
          ]);

          // Run diff
          const result = await runCLI(['snapshot', '-s', sessionName, '--diff', beforeFile]);

          expect(result.exitCode).toBe(0);
          // Should show summary line
          expect(result.stdout).toContain('Summary:');
          expect(result.stdout).toContain('added');
          expect(result.stdout).toContain('removed');

          // Cleanup
          await runCLI(['close', '-s', sessionName]).catch(() => {});
        } finally {
          fs.unlinkSync(beforeFile);
        }
      });
    }, 60000);
  });
});
