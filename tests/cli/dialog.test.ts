/**
 * CLI dialog handling tests
 *
 * Tests the --dialog flag for handling native browser dialogs via CLI.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { withRetry } from '../utils/retry';
import { generateSessionName, getBaseUrl, getWebSocketUrl, runCLI, setup, teardown } from './setup';

describe('CLI --dialog Flag', () => {
  beforeAll(setup);
  afterAll(teardown);

  const SESSION_NAME = generateSessionName();

  test('should create a session for dialog tests', async () => {
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

  test('should navigate to dialog test page', async () => {
    await withRetry(async () => {
      const baseUrl = getBaseUrl();

      const result = await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        JSON.stringify({ action: 'goto', url: `${baseUrl}/dialogs.html` }),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({ success: true });
    });
  }, 30000);

  test('should handle confirm dialog with --dialog accept', async () => {
    await withRetry(async () => {
      const result = await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        '--dialog',
        'accept',
        JSON.stringify([
          { action: 'click', selector: '[data-testid="trigger-confirm"]' },
          { action: 'wait', selector: '#confirm-result', waitFor: 'visible', timeout: 5000 },
          { action: 'text', selector: '#confirm-result' },
        ]),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({ success: true });

      // Verify the dialog was accepted (user clicked OK)
      const json = result.json as { steps?: Array<{ text?: string }> };
      const textStep = json.steps?.find((s) => s.text !== undefined);
      expect(textStep?.text).toContain('confirmed');
    });
  }, 30000);

  test('should handle confirm dialog with --dialog dismiss', async () => {
    await withRetry(async () => {
      // First reload to reset state
      const baseUrl = getBaseUrl();
      await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        JSON.stringify({ action: 'goto', url: `${baseUrl}/dialogs.html` }),
      ]);

      const result = await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        '--dialog',
        'dismiss',
        JSON.stringify([
          { action: 'click', selector: '[data-testid="trigger-confirm"]' },
          { action: 'wait', selector: '#confirm-result', waitFor: 'visible', timeout: 5000 },
          { action: 'text', selector: '#confirm-result' },
        ]),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({ success: true });

      // Verify the dialog was dismissed (user clicked Cancel)
      const json = result.json as { steps?: Array<{ text?: string }> };
      const textStep = json.steps?.find((s) => s.text !== undefined);
      expect(textStep?.text).toContain('dismissed');
    });
  }, 30000);

  test('should handle alert dialog with --dialog accept', async () => {
    await withRetry(async () => {
      // Reload page
      const baseUrl = getBaseUrl();
      await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        JSON.stringify({ action: 'goto', url: `${baseUrl}/dialogs.html` }),
      ]);

      const result = await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        '--dialog',
        'accept',
        JSON.stringify([
          { action: 'click', selector: '[data-testid="trigger-alert"]' },
          { action: 'wait', selector: '#alert-result', waitFor: 'visible', timeout: 5000 },
          { action: 'text', selector: '#alert-result' },
        ]),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({ success: true });

      // Alert was handled (dismissed)
      const json = result.json as { steps?: Array<{ text?: string }> };
      const textStep = json.steps?.find((s) => s.text !== undefined);
      expect(textStep?.text).toContain('Alert was dismissed');
    });
  }, 30000);

  test('should handle delete confirmation flow with --dialog accept', async () => {
    await withRetry(async () => {
      // Reload page
      const baseUrl = getBaseUrl();
      await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        JSON.stringify({ action: 'goto', url: `${baseUrl}/dialogs.html` }),
      ]);

      const result = await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        '--dialog',
        'accept',
        JSON.stringify([
          { action: 'click', selector: '[data-testid="delete-btn"]' },
          { action: 'wait', selector: '#delete-result', waitFor: 'visible', timeout: 5000 },
          { action: 'text', selector: '#delete-result' },
        ]),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({ success: true });

      // Confirm was accepted, item was deleted
      const json = result.json as { steps?: Array<{ text?: string }> };
      const textStep = json.steps?.find((s) => s.text !== undefined);
      expect(textStep?.text).toContain('deleted successfully');
    });
  }, 30000);

  test('should auto-dismiss dialog without --dialog flag (no hang)', async () => {
    await withRetry(async () => {
      // Reload page
      const baseUrl = getBaseUrl();
      await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        JSON.stringify({ action: 'goto', url: `${baseUrl}/dialogs.html` }),
      ]);

      // NO --dialog flag - should auto-dismiss and not hang
      // This previously would hang indefinitely
      const result = await runCLI([
        'exec',
        '-s',
        SESSION_NAME,
        '-o',
        'json',
        JSON.stringify([
          { action: 'click', selector: '[data-testid="trigger-confirm"]' },
          { action: 'wait', selector: '#confirm-result', waitFor: 'visible', timeout: 5000 },
          { action: 'text', selector: '#confirm-result' },
        ]),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({ success: true });

      // Auto-dismiss defaults to dismiss (cancel)
      const json = result.json as { steps?: Array<{ text?: string }> };
      const textStep = json.steps?.find((s) => s.text !== undefined);
      expect(textStep?.text).toContain('dismissed');
    });
  }, 30000);

  test('should close session', async () => {
    await withRetry(async () => {
      const result = await runCLI(['close', '-s', SESSION_NAME, '-o', 'json']);

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({ success: true });
    });
  }, 30000);
});
