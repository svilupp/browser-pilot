/**
 * CLI session persistence tests
 *
 * Note: These tests require the CLI commands to be fully implemented.
 * For now, we test basic CLI functionality.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { withRetry } from '../utils/retry';
import { generateSessionName, getBaseUrl, getChromePort, runCLI, setup, teardown } from './setup';

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

// Note: Full CLI session tests require the CLI commands to be implemented
// The tests below are placeholders that will work once the CLI is complete

describe.skip('CLI Session Persistence', () => {
  beforeAll(setup);
  afterAll(teardown);

  const SESSION_NAME = generateSessionName();

  test('should create a session', async () => {
    await withRetry(async () => {
      const port = getChromePort();

      const result = await runCLI([
        'connect',
        '--provider',
        'generic',
        '--url',
        `http://localhost:${port}`,
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
  });

  test('should navigate using session', async () => {
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
  });

  test('should close session', async () => {
    await withRetry(async () => {
      const result = await runCLI(['close', '-s', SESSION_NAME, '-o', 'json']);

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({ success: true });
    });
  });
});
