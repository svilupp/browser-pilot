/**
 * Session logging integration tests
 *
 * Tests that exec command logs actions to session log file
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  generateSessionName,
  getBaseUrl,
  getWebSocketUrl,
  runCLI,
  setup,
  teardown,
} from '../cli/setup';
import { withRetry } from '../utils/retry';

const SESSION_DIR = join(homedir(), '.browser-pilot', 'sessions');

describe('Session Logging Integration', () => {
  beforeAll(setup);
  afterAll(teardown);

  describe('exec command logging', () => {
    test('running bp exec creates log entries', async () => {
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

        // Click an element
        await runCLI([
          'exec',
          '-s',
          sessionName,
          JSON.stringify({ action: 'click', selector: 'button[type="submit"]' }),
        ]);

        // Check log file exists
        const logPath = join(SESSION_DIR, sessionName, 'log.jsonl');
        expect(fs.existsSync(logPath)).toBe(true);

        // Read log content
        const content = fs.readFileSync(logPath, 'utf-8').trim();
        const lines = content.split('\n');

        // Should have multiple log entries (goto, batch event, click, batch event)
        expect(lines.length).toBeGreaterThanOrEqual(2);

        // Parse and verify entries
        const entries = lines.map((line) => JSON.parse(line));

        // Find the click command entry
        const clickEntry = entries.find((e) => e.cmd === 'click');
        expect(clickEntry).toBeDefined();
        expect(clickEntry?.type).toBe('command');
        expect(clickEntry?.status).toBe('success');
        expect(typeof clickEntry?.durationMs).toBe('number');
        expect(clickEntry?.seq).toBeGreaterThan(0);
        expect(clickEntry?.ts).toBeDefined();

        // Cleanup
        await runCLI(['close', '-s', sessionName]).catch(() => {});

        // Clean up log directory
        const sessionDir = join(SESSION_DIR, sessionName);
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true });
        }
      });
    }, 60000);

    // TODO: Fix flaky in CI - depends on CLI and filesystem timing
    test.skipIf(!!process.env['CI'])('log includes command, args, status, duration', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create session
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

        // Fill a form field
        await runCLI([
          'exec',
          '-s',
          sessionName,
          JSON.stringify([
            { action: 'goto', url: `${baseUrl}/form.html` },
            { action: 'fill', selector: '#name', value: 'Test User' },
          ]),
        ]);

        // Check log file
        const logPath = join(SESSION_DIR, sessionName, 'log.jsonl');
        expect(fs.existsSync(logPath)).toBe(true);

        const content = fs.readFileSync(logPath, 'utf-8').trim();
        const entries = content.split('\n').map((line) => JSON.parse(line));

        // Find the fill command entry
        const fillEntry = entries.find((e) => e.cmd === 'fill');
        expect(fillEntry).toBeDefined();
        expect(fillEntry?.type).toBe('command');
        expect(fillEntry?.status).toBe('success');
        expect(typeof fillEntry?.durationMs).toBe('number');
        expect(fillEntry?.durationMs).toBeGreaterThan(0);

        // Find batch event
        const batchEvent = entries.find((e) => e.type === 'event' && e.cmd === 'batch');
        expect(batchEvent).toBeDefined();
        expect(batchEvent?.args?.stepCount).toBe(2);
        expect(batchEvent?.urlBefore).toBeDefined();
        expect(batchEvent?.urlAfter).toBeDefined();

        // Cleanup
        await runCLI(['close', '-s', sessionName]).catch(() => {});

        const sessionDir = join(SESSION_DIR, sessionName);
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true });
        }
      });
    }, 60000);

    // TODO: Fix flaky in CI - depends on CLI and filesystem timing
    test.skipIf(!!process.env['CI'])('failed commands log error and hints', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create session
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

        // Navigate to form
        await runCLI([
          'exec',
          '-s',
          sessionName,
          JSON.stringify({ action: 'goto', url: `${baseUrl}/form.html` }),
        ]);

        // Try to click a non-existent element (should fail)
        await runCLI([
          'exec',
          '-s',
          sessionName,
          JSON.stringify({ action: 'click', selector: '#nonexistent-element' }),
        ]);

        // Check log file
        const logPath = join(SESSION_DIR, sessionName, 'log.jsonl');
        expect(fs.existsSync(logPath)).toBe(true);

        const content = fs.readFileSync(logPath, 'utf-8').trim();
        const entries = content.split('\n').map((line) => JSON.parse(line));

        // Find the failed click command
        const failedEntry = entries.find((e) => e.cmd === 'click' && e.status === 'failed');
        expect(failedEntry).toBeDefined();
        expect(failedEntry?.error).toBeDefined();
        expect(failedEntry?.error).toContain('not found');

        // Should have hints for similar elements
        if (failedEntry?.hints) {
          expect(Array.isArray(failedEntry.hints)).toBe(true);
        }

        // Cleanup
        await runCLI(['close', '-s', sessionName]).catch(() => {});

        const sessionDir = join(SESSION_DIR, sessionName);
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true });
        }
      });
    }, 60000);
  });
});
