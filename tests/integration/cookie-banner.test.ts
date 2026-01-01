/**
 * Cookie banner integration tests
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { expectElementText, expectHasClass } from '../utils/assertions';
import { withRetry } from '../utils/retry';
import { TestContext } from './setup';

// Each test file gets its own isolated context
const ctx = new TestContext();

describe('Cookie Banner', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  test('should show banner initially', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/cookie-banner.html`);

      // Banner should be visible (not hidden)
      await expectHasClass(page, '#cookie-banner', 'hidden', false);

      // Status should be pending
      await expectElementText(page, '#status', 'pending');
    });
  });

  test('should accept cookies and hide banner', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/cookie-banner.html`);

      // Click accept
      await page.click('#accept-cookies');

      // Banner should be hidden
      await expectHasClass(page, '#cookie-banner', 'hidden', true);

      // Status should update
      await expectElementText(page, '#status', 'accepted');
    });
  });

  test('should reject cookies and hide banner', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/cookie-banner.html`);

      // Click reject
      await page.click('#reject-cookies');

      // Banner should be hidden
      await expectHasClass(page, '#cookie-banner', 'hidden', true);

      // Status should update
      await expectElementText(page, '#status', 'rejected');
    });
  });

  test('should handle customize click', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/cookie-banner.html`);

      // Click customize
      await page.click('#customize-cookies');

      // Status should update to customizing
      await expectElementText(page, '#status', 'customizing');

      // Banner should still be visible
      await expectHasClass(page, '#cookie-banner', 'hidden', false);
    });
  });

  test('should use multi-selector for cookie accept', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/cookie-banner.html`);

      // Simulate real-world scenario with multiple possible selectors
      const clicked = await page.click([
        '#nonexistent-accept',
        '.cookie-accept-button',
        'button.accept',
        '#accept-cookies', // This one exists
      ]);

      expect(clicked).toBe(true);
      await expectHasClass(page, '#cookie-banner', 'hidden', true);
      await expectElementText(page, '#status', 'accepted');
    });
  });

  test('should reset and show banner again', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/cookie-banner.html`);

      // Accept first
      await page.click('#accept-cookies');
      await expectHasClass(page, '#cookie-banner', 'hidden', true);

      // Reset
      await page.click('#reset-consent');

      // Banner should be visible again
      await expectHasClass(page, '#cookie-banner', 'hidden', false);
      await expectElementText(page, '#status', 'pending');
    });
  });

  test('should handle cookie banner via batch with optional', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/cookie-banner.html`);

      // Try to click any of these selectors (simulating different sites)
      const result = await page.batch([
        {
          action: 'click',
          selector: ['#accept-all', '.accept-cookies', '#accept-cookies'],
          optional: true,
          timeout: 2000,
        },
      ]);

      expect(result.success).toBe(true);
      await expectElementText(page, '#status', 'accepted');
    });
  });
});
