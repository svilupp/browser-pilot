/**
 * Shadow DOM integration tests
 *
 * Tests selector piercing through shadow DOM boundaries.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { withRetry } from '../utils/retry';
import { TestContext } from './setup';

const ctx = new TestContext();

describe('Shadow DOM', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  // === Level 1: Simple Shadow DOM ===

  test('should click button inside shadow DOM', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/shadow-dom.html`);

      // Click button inside simple shadow DOM
      await page.click('[data-testid="shadow-button"]', { timeout: 5000 });

      // Verify result appeared
      await page.waitFor('#simple-result', { state: 'visible', timeout: 3000 });
      const text = await page.text('#simple-result');
      expect(text).toContain('Simple shadow button clicked');
    });
  }, 30000);

  // === Level 2: Nested Shadow DOM ===

  test('should click button in nested shadow DOM (2 levels)', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/shadow-dom.html`);

      // Click button inside nested shadow DOM (outer-component > inner-button)
      await page.click('[data-testid="nested-button"]', { timeout: 5000 });

      // Verify result
      await page.waitFor('#nested-result', { state: 'visible', timeout: 3000 });
      const text = await page.text('#nested-result');
      expect(text).toContain('Nested shadow button clicked');
    });
  }, 30000);

  // === Shadow DOM Form - Simplified ===

  test('should fill input inside shadow DOM', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/shadow-dom.html`);

      // Fill single input in shadow DOM
      await page.fill('[data-testid="shadow-input"]', 'John Doe', { timeout: 5000 });

      // Verify the value was filled
      const value = await page.evaluate(`
        (() => {
          const root = document.querySelector('shadow-form')?.shadowRoot;
          return root?.querySelector('[data-testid="shadow-input"]')?.value || '';
        })()
      `);
      expect(value).toBe('John Doe');
    });
  }, 30000);

  // === Mixed Light + Shadow DOM ===

  test('should click button in mixed light/shadow DOM component', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/shadow-dom.html`);

      // Click button inside mixed component's shadow DOM
      await page.click('[data-testid="mixed-shadow-btn"]', { timeout: 5000 });

      // Verify result
      await page.waitFor('#mixed-result', { state: 'visible', timeout: 3000 });
      const text = await page.text('#mixed-result');
      expect(text).toContain('Mixed shadow button clicked');
    });
  }, 30000);

  // === Snapshot with Shadow DOM ===

  test('should include shadow DOM elements in snapshot', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/shadow-dom.html`);

      const snapshot = await page.snapshot();

      // Should have captured interactive elements
      expect(snapshot.interactiveElements.length).toBeGreaterThan(0);

      // Should have button roles (from shadow DOM buttons)
      const buttons = snapshot.interactiveElements.filter((e) => e.role === 'button');
      expect(buttons.length).toBeGreaterThan(0);
    });
  }, 30000);

  // === Wait for Shadow DOM Elements ===

  test('should wait for element in shadow DOM', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/shadow-dom.html`);

      // Wait for shadow button to be visible
      const found = await page.waitFor('[data-testid="shadow-button"]', {
        state: 'visible',
        timeout: 5000,
      });

      expect(found).toBe(true);
    });
  }, 30000);

  // === Multi-selector with Shadow DOM ===

  test('should work with multi-selector including shadow DOM elements', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/shadow-dom.html`);

      // Use multi-selector - first one is in shadow DOM
      await page.click([
        '[data-testid="shadow-button"]',
        '[data-testid="nested-button"]',
        '#main-btn',
      ], { timeout: 5000 });

      // Should have clicked the first one (shadow-button)
      await page.waitFor('#simple-result', { state: 'visible', timeout: 3000 });
      const text = await page.text('#simple-result');
      expect(text).toContain('Simple shadow button clicked');
    });
  }, 30000);
});
