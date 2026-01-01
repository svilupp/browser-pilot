/**
 * Iframe integration tests
 *
 * Tests for switching between iframe contexts and interacting with iframe content.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { withRetry } from '../utils/retry';
import { TestContext } from './setup';

const ctx = new TestContext();

describe('Iframe Navigation', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  // === Basic Iframe Switching ===

  test('should detect iframe on page', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/iframe-parent.html`);

      // Wait for iframe element to be visible
      const found = await page.waitFor('[data-testid="child-frame"]', {
        state: 'visible',
        timeout: 5000,
      });

      expect(found).toBe(true);
    });
  }, 30000);

  test('should switch to iframe and fill input', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/iframe-parent.html`);

      // Wait for iframe to load
      await page.waitFor('[data-testid="child-frame"]', { state: 'visible', timeout: 5000 });

      // Switch to the child iframe
      const switched = await page.switchToFrame('[data-testid="child-frame"]');
      expect(switched).toBe(true);

      // Fill a single input inside iframe
      await page.fill('[data-testid="iframe-input-name"]', 'Test Name', { timeout: 5000 });

      // Verify the input was filled by reading its value
      const value = await page.evaluate(
        'document.querySelector("[data-testid=\\"iframe-input-name\\"]")?.value || ""'
      );
      expect(value).toBe('Test Name');
    });
  }, 30000);

  test('should switch to iframe and back', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/iframe-parent.html`);

      // Initially in main frame
      expect(page.getCurrentFrame()).toBe(null);

      // Switch to iframe
      const switched = await page.switchToFrame('[data-testid="child-frame"]');
      expect(switched).toBe(true);
      expect(page.getCurrentFrame()).not.toBe(null);

      // Switch back to main frame
      await page.switchToMain();
      expect(page.getCurrentFrame()).toBe(null);
    });
  }, 30000);

  test('should interact with main frame after switchToMain', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/iframe-parent.html`);

      // Switch to iframe then back
      await page.switchToFrame('[data-testid="child-frame"]');
      await page.switchToMain();

      // Should be able to interact with main frame elements
      await page.click('[data-testid="main-button"]', { timeout: 5000 });

      // Verify main frame result
      await page.waitFor('#main-result', { state: 'visible', timeout: 3000 });
      const text = await page.text('#main-result');
      expect(text).toContain('Main frame button clicked');
    });
  }, 30000);

  // === Batch Execution with Iframes ===

  test('should support iframe workflow in batch execution', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/iframe-parent.html`);

      // Wait for page to fully load
      await page.waitFor('[data-testid="child-frame"]', { state: 'visible', timeout: 5000 });

      const result = await page.batch([
        { action: 'switchFrame', selector: '[data-testid="child-frame"]' },
        { action: 'fill', selector: '[data-testid="iframe-input-name"]', value: 'Batch Test' },
        { action: 'switchToMain' },
        { action: 'click', selector: '[data-testid="main-button"]' },
      ]);

      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(4);
      expect(result.steps.every((s) => s.success)).toBe(true);
    });
  }, 30000);

  // === Frame Context Tracking ===

  test('should track current frame context', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/iframe-parent.html`);

      // Initially in main frame
      expect(page.getCurrentFrame()).toBe(null);

      // Switch to iframe
      await page.switchToFrame('[data-testid="child-frame"]');
      expect(page.getCurrentFrame()).not.toBe(null);

      // Switch back
      await page.switchToMain();
      expect(page.getCurrentFrame()).toBe(null);
    });
  }, 30000);

  // === Nested Iframes ===

  test('should switch to nested iframe (2 levels deep)', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/iframe-parent.html`);

      // Wait for outer nested-frame to load
      await page.waitFor('[data-testid="nested-frame"]', { state: 'visible', timeout: 5000 });

      // Switch to first level (nested-frame container)
      const level1 = await page.switchToFrame('[data-testid="nested-frame"]');
      expect(level1).toBe(true);

      // Click button at level 1
      await page.click('[data-testid="level1-button"]', { timeout: 5000 });

      // Verify level 1 result
      await page.waitFor('#level1-result', { state: 'visible', timeout: 3000 });
      const text = await page.text('#level1-result');
      expect(text).toContain('Level 1 button clicked');
    });
  }, 30000);

  test('should switch to deeply nested iframe and interact', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/iframe-parent.html`);

      // Wait for outer nested-frame to load
      await page.waitFor('[data-testid="nested-frame"]', { state: 'visible', timeout: 5000 });

      // Switch to level 1 (nested-frame container)
      await page.switchToFrame('[data-testid="nested-frame"]');

      // Wait for inner frame to be visible within level 1
      await page.waitFor('[data-testid="inner-frame"]', { state: 'visible', timeout: 5000 });

      // Switch to level 2 (inner-frame with form)
      const level2 = await page.switchToFrame('[data-testid="inner-frame"]');
      expect(level2).toBe(true);

      // Fill form inside level 2 iframe
      await page.fill('[data-testid="iframe-input-name"]', 'Nested Test', { timeout: 5000 });

      // Verify the input was filled
      const value = await page.evaluate(
        'document.querySelector("[data-testid=\\"iframe-input-name\\"]")?.value || ""'
      );
      expect(value).toBe('Nested Test');
    });
  }, 30000);

  // === Error Handling ===

  test('should fail gracefully for non-existent iframe', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/iframe-parent.html`);

      // Try to switch to non-existent iframe
      const success = await page.switchToFrame('[data-testid="nonexistent"]', {
        optional: true,
        timeout: 2000,
      });

      expect(success).toBe(false);
    });
  }, 30000);
});
