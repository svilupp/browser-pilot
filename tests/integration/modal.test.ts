/**
 * Modal interaction integration tests
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { expectHasClass, expectInputValue, expectTextContent } from '../utils/assertions';
import { withRetry } from '../utils/retry';
import { TestContext } from './setup';

// Each test file gets its own isolated context
const ctx = new TestContext();

describe('Modal Interactions', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  test('should open modal', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/modal.html`);

      // Modal should be hidden initially
      const initiallyClosed = await page.evaluate(() => {
        const el = document.getElementById('modal-overlay');
        return el && !el.classList.contains('open');
      });
      expect(initiallyClosed).toBe(true);

      // Open modal
      await page.click('#open-modal');

      // Modal should be visible
      await expectHasClass(page, '#modal-overlay', 'open', true);
    });
  });

  test('should fill modal form', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/modal.html`);

      // Open modal
      await page.click('#open-modal');
      await expectHasClass(page, '#modal-overlay', 'open', true);

      // Fill form fields
      await page.fill('#modal-name', 'Alice');
      await page.fill('#modal-email', 'alice@example.com');
      await page.fill('#modal-subject', 'Test Subject');

      // Verify values
      await expectInputValue(page, '#modal-name', 'Alice');
      await expectInputValue(page, '#modal-email', 'alice@example.com');
      await expectInputValue(page, '#modal-subject', 'Test Subject');
    });
  });

  test('should submit modal form', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/modal.html`);

      // Open modal
      await page.click('#open-modal');

      // Fill form
      await page.fill('#modal-name', 'Bob');
      await page.fill('#modal-email', 'bob@example.com');

      // Submit
      await page.click('#modal-submit');

      // Modal should close and show result
      await expectHasClass(page, '#modal-overlay', 'open', false);
      await expectHasClass(page, '#result', 'visible', true);
      await expectTextContent(page, 'Modal submitted successfully');
      await expectTextContent(page, 'Bob');
      await expectTextContent(page, 'bob@example.com');
    });
  });

  test('should cancel modal', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/modal.html`);

      // Open modal
      await page.click('#open-modal');
      await expectHasClass(page, '#modal-overlay', 'open', true);

      // Fill something
      await page.fill('#modal-name', 'Test');

      // Cancel
      await page.click('#modal-cancel');

      // Modal should close
      await expectHasClass(page, '#modal-overlay', 'open', false);

      // Result should NOT be visible
      await expectHasClass(page, '#result', 'visible', false);
    });
  });

  test('should handle full modal workflow', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/modal.html`);

      // Complete workflow:
      // 1. Open modal
      await page.click('#open-modal');

      // 2. Wait for modal to be visible
      await page.waitFor('#modal-overlay.open', { timeout: 2000 });

      // 3. Fill form
      await page.fill('#modal-name', 'Complete Test');
      await page.fill('#modal-email', 'complete@test.com');
      await page.fill('#modal-subject', 'Full Workflow');

      // 4. Submit
      await page.click('#modal-submit');

      // 5. Verify success
      await expectTextContent(page, 'Modal submitted successfully');
      await expectTextContent(page, 'Complete Test');
    });
  });

  test('should handle modal via batch', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/modal.html`);

      const result = await page.batch([
        { action: 'click', selector: '#open-modal' },
        { action: 'wait', selector: '#modal-overlay.open', waitFor: 'visible' },
        { action: 'fill', selector: '#modal-name', value: 'Batch User' },
        { action: 'fill', selector: '#modal-email', value: 'batch@example.com' },
        { action: 'click', selector: '#modal-submit' },
      ]);

      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(5);
      expect(result.steps.every((s) => s.success)).toBe(true);

      await expectTextContent(page, 'Batch User');
    });
  });
});
