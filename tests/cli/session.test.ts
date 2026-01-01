/**
 * CLI session persistence tests
 *
 * Tests CLI commands for session management: connect, exec, close.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { withRetry } from '../utils/retry';
import {
  generateSessionName,
  getBaseUrl,
  getWebSocketUrl,
  runCLI,
  setup,
  teardown,
} from './setup';

describe('CLI Basic Functionality', () => {
  beforeAll(setup);
  afterAll(teardown);

  test('should show help', async () => {
    const result = await runCLI(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('browser-pilot');
  });

  test('should show version or usage', async () => {
    const result = await runCLI([]);

    // Either shows help or version
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});

describe('CLI Session Persistence', () => {
  beforeAll(setup);
  afterAll(teardown);

  const SESSION_NAME = generateSessionName();

  test(
    'should create a session',
    async () => {
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
    },
    30000
  );

  test(
    'should navigate using session',
    async () => {
      await withRetry(async () => {
        const baseUrl = getBaseUrl();

        const result = await runCLI([
          'exec',
          '-s',
          SESSION_NAME,
          '-o',
          'json',
          JSON.stringify({ action: 'goto', url: `${baseUrl}/basic.html` }),
        ]);

        expect(result.exitCode).toBe(0);
        expect(result.json).toMatchObject({ success: true });
      });
    },
    30000
  );

  test(
    'should close session',
    async () => {
      await withRetry(async () => {
        const result = await runCLI(['close', '-s', SESSION_NAME, '-o', 'json']);

        expect(result.exitCode).toBe(0);
        expect(result.json).toMatchObject({ success: true });
      });
    },
    30000
  );
});
