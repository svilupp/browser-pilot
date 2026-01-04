/**
 * CLI session lifecycle tests
 *
 * Tests for session persistence issues:
 * - Stale session detection
 * - Session cleanup
 * - Session validation
 *
 * Pain points addressed:
 * 1. "Sessions listed by bp list sometimes return 'Session with given id not found'"
 * 2. "Old test sessions persist across CLI restarts and clutter bp list output"
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withRetry } from '../utils/retry';
import { generateSessionName, getBaseUrl, getWebSocketUrl, runCLI, setup, teardown } from './setup';

const SESSIONS_DIR = join(homedir(), '.browser-pilot', 'sessions');

describe('CLI Session Lifecycle', () => {
  beforeAll(setup);
  afterAll(teardown);

  describe('Session Listing', () => {
    test('should list active sessions', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();

        // Create session
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

        // List sessions
        const result = await runCLI(['list', '-o', 'json']);

        expect(result.exitCode).toBe(0);
        const sessions = result.json as Array<{ id: string }>;
        expect(sessions.some((s) => s.id === sessionName)).toBe(true);

        // Cleanup
        await runCLI(['close', '-s', sessionName]).catch(() => {});
      });
    }, 30000);

    test('should show session details in list', async () => {
      const sessionName = generateSessionName();

      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();

        // Create session
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

        // Navigate to a page
        const baseUrl = getBaseUrl();
        await runCLI([
          'exec',
          '-s',
          sessionName,
          JSON.stringify({ action: 'goto', url: `${baseUrl}/basic.html` }),
        ]);

        // List sessions and check details
        const result = await runCLI(['list', '-o', 'json']);
        const sessions = result.json as Array<{
          id: string;
          provider: string;
          currentUrl: string;
          lastActivity: string;
        }>;

        const session = sessions.find((s) => s.id === sessionName);
        expect(session).toBeDefined();
        expect(session?.provider).toBe('generic');
        expect(session?.currentUrl).toContain('basic.html');
        expect(session?.lastActivity).toBeDefined();

        // Cleanup
        await runCLI(['close', '-s', sessionName]).catch(() => {});
      });
    }, 30000);
  });

  describe('Stale Session Handling', () => {
    test('should handle session file without valid browser', async () => {
      // Create a fake stale session file
      const staleSessionName = `stale-${Date.now()}`;
      const sessionFile = join(SESSIONS_DIR, `${staleSessionName}.json`);

      await mkdir(SESSIONS_DIR, { recursive: true });

      const fakeSession = {
        id: staleSessionName,
        provider: 'generic',
        wsUrl: 'ws://localhost:99999/devtools/browser/fake', // Invalid URL
        createdAt: new Date(Date.now() - 86400000).toISOString(), // 24 hours ago
        lastActivity: new Date(Date.now() - 86400000).toISOString(),
        currentUrl: 'about:blank',
      };

      await writeFile(sessionFile, JSON.stringify(fakeSession, null, 2));

      try {
        // List should include the stale session
        const listResult = await runCLI(['list', '-o', 'json']);
        const sessions = listResult.json as Array<{ id: string }>;
        expect(sessions.some((s) => s.id === staleSessionName)).toBe(true);

        // Exec should fail gracefully with stale session
        const execResult = await runCLI([
          'exec',
          '-s',
          staleSessionName,
          '-o',
          'json',
          JSON.stringify({ action: 'snapshot' }),
        ]);

        // Should fail (connection error)
        expect(execResult.exitCode).not.toBe(0);
      } finally {
        // Cleanup
        await rm(sessionFile, { force: true });
      }
    });

    test('should detect old sessions by lastActivity', async () => {
      // Create an old session file
      const oldSessionName = `old-${Date.now()}`;
      const sessionFile = join(SESSIONS_DIR, `${oldSessionName}.json`);

      await mkdir(SESSIONS_DIR, { recursive: true });

      const oldSession = {
        id: oldSessionName,
        provider: 'generic',
        wsUrl: 'ws://localhost:99999/devtools/browser/fake',
        createdAt: new Date(Date.now() - 7 * 86400000).toISOString(), // 7 days ago
        lastActivity: new Date(Date.now() - 7 * 86400000).toISOString(),
        currentUrl: 'about:blank',
      };

      await writeFile(sessionFile, JSON.stringify(oldSession, null, 2));

      try {
        const result = await runCLI(['list', '-o', 'json']);
        const sessions = result.json as Array<{
          id: string;
          lastActivity: string;
        }>;

        const session = sessions.find((s) => s.id === oldSessionName);
        expect(session).toBeDefined();

        // Calculate age
        const lastActivity = new Date(session!.lastActivity);
        const ageMs = Date.now() - lastActivity.getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);

        expect(ageDays).toBeGreaterThan(6);
      } finally {
        await rm(sessionFile, { force: true });
      }
    });
  });

  describe('Session Cleanup', () => {
    test('bp close should remove session file', async () => {
      await withRetry(async () => {
        const wsUrl = await getWebSocketUrl();
        const sessionName = generateSessionName();

        // Create session
        await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);

        // Verify file exists
        const sessionFile = join(SESSIONS_DIR, `${sessionName}.json`);
        const statsBefore = await stat(sessionFile).catch(() => null);
        expect(statsBefore).not.toBeNull();

        // Close session
        await runCLI(['close', '-s', sessionName]);

        // Verify file is removed
        const statsAfter = await stat(sessionFile).catch(() => null);
        expect(statsAfter).toBeNull();
      });
    }, 30000);

    test('should be able to clean multiple sessions manually', async () => {
      // Create multiple stale session files
      const staleNames = [`stale-a-${Date.now()}`, `stale-b-${Date.now()}`];

      await mkdir(SESSIONS_DIR, { recursive: true });

      for (const name of staleNames) {
        const sessionFile = join(SESSIONS_DIR, `${name}.json`);
        const fakeSession = {
          id: name,
          provider: 'generic',
          wsUrl: 'ws://localhost:99999/fake',
          createdAt: new Date(Date.now() - 86400000).toISOString(),
          lastActivity: new Date(Date.now() - 86400000).toISOString(),
          currentUrl: 'about:blank',
        };
        await writeFile(sessionFile, JSON.stringify(fakeSession, null, 2));
      }

      try {
        // List should show both
        const listResult = await runCLI(['list', '-o', 'json']);
        const sessions = listResult.json as Array<{ id: string }>;

        for (const name of staleNames) {
          expect(sessions.some((s) => s.id === name)).toBe(true);
        }

        // Manually remove each
        for (const name of staleNames) {
          const sessionFile = join(SESSIONS_DIR, `${name}.json`);
          await rm(sessionFile, { force: true });
        }

        // List should no longer show them
        const listResult2 = await runCLI(['list', '-o', 'json']);
        const sessions2 = listResult2.json as Array<{ id: string }>;

        for (const name of staleNames) {
          expect(sessions2.some((s) => s.id === name)).toBe(false);
        }
      } finally {
        // Cleanup any remaining
        for (const name of staleNames) {
          await rm(join(SESSIONS_DIR, `${name}.json`), { force: true });
        }
      }
    });
  });
});
