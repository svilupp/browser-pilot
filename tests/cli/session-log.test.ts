/**
 * Session log CLI tests
 *
 * Tests for bp list --log-path, --log-tail, --info
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withRetry } from '../utils/retry';
import { generateSessionName, getBaseUrl, getWebSocketUrl, runCLI, setup, teardown } from './setup';

const SESSION_DIR = join(homedir(), '.browser-pilot', 'sessions');

describe.skipIf(!!process.env['CI'])('Session Log CLI', () => {
  beforeAll(setup);
  afterAll(teardown);

  describe('--log-path', () => {
    test('outputs correct path to log file', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create session
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

        // Execute an action to create log entries
        await runCLI([
          'exec',
          '-s',
          sessionName,
          JSON.stringify({ action: 'goto', url: `${baseUrl}/basic.html` }),
        ]);

        // Get log path
        const result = await runCLI(['list', '-s', sessionName, '--log-path']);

        expect(result.exitCode).toBe(0);

        // Path should be absolute and point to log.jsonl
        const logPath = result.stdout.trim();
        expect(logPath).toContain(sessionName);
        expect(logPath).toContain('log.jsonl');
        expect(logPath.startsWith('/')).toBe(true);

        // File should exist
        expect(fs.existsSync(logPath)).toBe(true);

        // Cleanup
        await runCLI(['close', '-s', sessionName]).catch(() => {});

        const sessionDir = join(SESSION_DIR, sessionName);
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true });
        }
      });
    }, 60000);
  });

  describe('--log-tail', () => {
    test('shows last 20 entries by default', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create session
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

        // Execute some actions
        await runCLI([
          'exec',
          '-s',
          sessionName,
          JSON.stringify([
            { action: 'goto', url: `${baseUrl}/form.html` },
            { action: 'fill', selector: '#name', value: 'Test' },
          ]),
        ]);

        // Get log tail
        const result = await runCLI(['list', '-s', sessionName, '--log-tail']);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('log entries for session');
        expect(result.stdout).toContain('goto');
        expect(result.stdout).toContain('fill');

        // Cleanup
        await runCLI(['close', '-s', sessionName]).catch(() => {});

        const sessionDir = join(SESSION_DIR, sessionName);
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true });
        }
      });
    }, 60000);

    test('shows last n entries when specified', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create session and execute actions
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

        await runCLI([
          'exec',
          '-s',
          sessionName,
          JSON.stringify([
            { action: 'goto', url: `${baseUrl}/form.html` },
            { action: 'fill', selector: '#name', value: 'Test1' },
            { action: 'fill', selector: '#email', value: 'test@test.com' },
          ]),
        ]);

        // Get last 2 entries
        const result = await runCLI(['list', '-s', sessionName, '--log-tail', '2']);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Last 2 log entries');

        // Cleanup
        await runCLI(['close', '-s', sessionName]).catch(() => {});

        const sessionDir = join(SESSION_DIR, sessionName);
        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true });
        }
      });
    }, 60000);

    test('outputs JSON when --json specified', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create session and execute actions
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

        await runCLI([
          'exec',
          '-s',
          sessionName,
          JSON.stringify({ action: 'goto', url: `${baseUrl}/basic.html` }),
        ]);

        // Get log tail as JSON
        const result = await runCLI(['list', '-s', sessionName, '--log-tail', '5', '-f', 'json']);

        expect(result.exitCode).toBe(0);

        const entries = result.json as Array<{ seq: number; ts: string; type: string }>;
        expect(Array.isArray(entries)).toBe(true);

        if (entries.length > 0) {
          expect(entries[0]?.seq).toBeDefined();
          expect(entries[0]?.ts).toBeDefined();
          expect(entries[0]?.type).toBeDefined();
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

  describe('--info', () => {
    test('shows detailed session info with log stats', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const baseUrl = getBaseUrl();

        // Create session and execute actions
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

        await runCLI([
          'exec',
          '-s',
          sessionName,
          JSON.stringify({ action: 'goto', url: `${baseUrl}/basic.html` }),
        ]);

        // Get session info
        const result = await runCLI(['list', '-s', sessionName, '--info']);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(`Session: ${sessionName}`);
        expect(result.stdout).toContain('Provider:');
        expect(result.stdout).toContain('Created:');
        expect(result.stdout).toContain('Log Stats:');
        expect(result.stdout).toContain('Path:');
        expect(result.stdout).toContain('Entries:');

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
