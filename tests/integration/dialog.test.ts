/**
 * Native dialog handling integration tests
 *
 * Tests for handling native browser dialogs (alert, confirm, prompt).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { withRetry } from '../utils/retry';
import { TestContext } from './setup';

const ctx = new TestContext();

describe('Native Dialog Handling', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  // === Alert Dialog ===

  test('should auto-dismiss alert dialog', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/dialogs.html`);

      // Set up dialog handler to accept
      await page.onDialog(async (dialog) => {
        expect(dialog.type).toBe('alert');
        await dialog.accept();
      });

      // Trigger alert
      await page.click('[data-testid="trigger-alert"]', { timeout: 5000 });

      // Wait for result to appear
      await page.waitFor('#alert-result', { state: 'visible', timeout: 5000 });

      // Verify alert was handled
      const text = await page.text('#alert-result');
      expect(text).toContain('Alert was dismissed');
    });
  }, 30000);

  // === Confirm Dialog ===

  test('should accept confirm dialog', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/dialogs.html`);

      // Set up dialog handler to accept
      await page.onDialog(async (dialog) => {
        await dialog.accept();
      });

      // Trigger confirm
      await page.click('[data-testid="trigger-confirm"]', { timeout: 5000 });

      // Wait for result
      await page.waitFor('#confirm-result', { state: 'visible', timeout: 5000 });

      // Verify confirm was accepted
      const text = await page.text('#confirm-result');
      expect(text).toContain('confirmed');
    });
  }, 30000);

  test('should dismiss confirm dialog', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/dialogs.html`);

      // Set up dialog handler to dismiss
      await page.onDialog(async (dialog) => {
        await dialog.dismiss();
      });

      // Trigger confirm
      await page.click('[data-testid="trigger-confirm"]', { timeout: 5000 });

      // Wait for result
      await page.waitFor('#confirm-result', { state: 'visible', timeout: 5000 });

      // Verify confirm was dismissed
      const text = await page.text('#confirm-result');
      expect(text).toContain('dismissed');
    });
  }, 30000);

  // === Prompt Dialog ===

  test('should accept prompt dialog with text', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/dialogs.html`);

      // Set up dialog handler to accept with text
      await page.onDialog(async (dialog) => {
        await dialog.accept('Test User');
      });

      // Trigger prompt
      await page.click('[data-testid="trigger-prompt"]', { timeout: 5000 });

      // Wait for result
      await page.waitFor('#prompt-result', { state: 'visible', timeout: 5000 });

      // Verify prompt was accepted with our text
      const text = await page.text('#prompt-result');
      expect(text).toContain('Test User');
    });
  }, 30000);

  // === Delete with Confirmation ===

  test('should handle delete confirmation (accept)', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/dialogs.html`);

      // Set up handler to accept
      await page.onDialog(async (dialog) => {
        await dialog.accept();
      });

      // Click delete
      await page.click('[data-testid="delete-btn"]', { timeout: 5000 });

      // Wait for result
      await page.waitFor('#delete-result', { state: 'visible', timeout: 5000 });

      // Verify item was deleted
      const text = await page.text('#delete-result');
      expect(text).toContain('deleted successfully');
    });
  }, 30000);

  // === Dialog Properties ===

  test('should provide dialog type and message', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/dialogs.html`);

      let capturedType: string | undefined;
      let capturedMessage: string | undefined;

      await page.onDialog(async (dialog) => {
        capturedType = dialog.type;
        capturedMessage = dialog.message;
        await dialog.accept();
      });

      await page.click('[data-testid="trigger-confirm"]', { timeout: 5000 });
      await page.waitFor('#confirm-result', { state: 'visible', timeout: 5000 });

      expect(capturedType).toBe('confirm');
      expect(capturedMessage).toContain('proceed');
    });
  }, 30000);
});
