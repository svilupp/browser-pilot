/**
 * Checkbox and radio button integration tests
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  expectChecked,
  expectElementText,
  expectHasClass,
  expectTextContent,
} from '../utils/assertions';
import { withRetry } from '../utils/retry';
import { TestContext } from './setup';

// Each test file gets its own isolated context
const ctx = new TestContext();

describe('Checkbox and Radio Interactions', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  // === Checkbox Tests ===

  test('should check a checkbox', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/checkboxes.html`);

      await page.check('#newsletter');

      await expectChecked(page, '#newsletter', true);
    });
  });

  test('should uncheck a checkbox', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/checkboxes.html`);

      // Check first
      await page.check('#newsletter');
      await expectChecked(page, '#newsletter', true);

      // Then uncheck
      await page.uncheck('#newsletter');
      await expectChecked(page, '#newsletter', false);
    });
  });

  test('should check multiple checkboxes', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/checkboxes.html`);

      await page.check('#newsletter');
      await page.check('#notifications');
      await page.check('#analytics');

      await expectChecked(page, '#newsletter', true);
      await expectChecked(page, '#notifications', true);
      await expectChecked(page, '#analytics', true);
      await expectChecked(page, '#marketing', false); // Not checked
    });
  });

  test('should update state display when checking', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/checkboxes.html`);

      await page.check('#newsletter');
      await page.check('#notifications');

      const checkedText = await page.evaluate(() => {
        return document.getElementById('checked-list')?.textContent || '';
      });

      expect(checkedText).toContain('newsletter');
      expect(checkedText).toContain('notifications');
    });
  });

  test('should not affect disabled checkbox', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/checkboxes.html`);

      // Try to check disabled checkbox (should fail or be ignored)
      await page.check('#premium', { optional: true, timeout: 1000 });

      // Should still be unchecked
      await expectChecked(page, '#premium', false);
    });
  });

  // === Radio Button Tests ===

  test('should select radio button', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/checkboxes.html`);

      await page.check('#contact-email');

      await expectChecked(page, '#contact-email', true);
    });
  });

  test('should switch between radio buttons', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/checkboxes.html`);

      // Select email
      await page.check('#contact-email');
      await expectChecked(page, '#contact-email', true);

      // Select phone (should deselect email)
      await page.check('#contact-phone');
      await expectChecked(page, '#contact-phone', true);
      await expectChecked(page, '#contact-email', false);

      // Select SMS
      await page.check('#contact-sms');
      await expectChecked(page, '#contact-sms', true);
      await expectChecked(page, '#contact-phone', false);
    });
  });

  test('should update state display when selecting radio', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/checkboxes.html`);

      await page.check('#contact-phone');

      await expectElementText(page, '#contact-method', 'phone');
    });
  });

  // === Form Submission Tests ===

  test('should fail without accepting terms', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/checkboxes.html`);

      // Check some preferences but not terms
      await page.check('#newsletter');
      await page.check('#contact-email');

      // Submit
      await page.click('#save-preferences');

      // Wait for result to be visible and have error class
      await page.waitFor('#submit-result.error', { timeout: 2000 });

      // Should show error
      await expectHasClass(page, '#submit-result', 'error', true);
      await expectTextContent(page, 'terms and conditions');
    });
  });

  test('should submit form with checkboxes', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/checkboxes.html`);

      // Check preferences
      await page.check('#newsletter');
      await page.check('#notifications');
      await page.check('#terms');
      await page.check('#contact-phone');
      await page.check('#freq-weekly');

      // Submit
      await page.click('#save-preferences');

      // Should show success
      await expectHasClass(page, '#submit-result', 'success', true);
      await expectTextContent(page, 'Preferences saved');
      await expectTextContent(page, 'newsletter');
      await expectTextContent(page, 'phone');
      await expectTextContent(page, 'weekly');
    });
  });

  test('should handle checkbox form via batch', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/checkboxes.html`);

      const result = await page.batch([
        { action: 'check', selector: '#newsletter' },
        { action: 'check', selector: '#notifications' },
        { action: 'check', selector: '#terms' },
        { action: 'check', selector: '#contact-email' },
        { action: 'click', selector: '#save-preferences' },
      ]);

      expect(result.success).toBe(true);
      await expectHasClass(page, '#submit-result', 'success', true);
    });
  });
});
