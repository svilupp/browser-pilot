/**
 * Click action integration tests
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { expectHasClass } from '../utils/assertions';
import { withRetry } from '../utils/retry';
import { TestContext } from './setup';

// Each test file gets its own isolated context
const ctx = new TestContext();

describe('Click Actions', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  test('should click a button', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      // Dynamic content should be hidden initially
      const initiallyHidden = await page.evaluate(() => {
        const el = document.getElementById('dynamic');
        return el && !el.classList.contains('visible');
      });
      expect(initiallyHidden).toBe(true);

      // Click button to show it
      await page.click('#show-dynamic');

      // Should now be visible
      await expectHasClass(page, '#dynamic', 'visible', true);
    });
  });

  test('should click using first matching selector', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      // First selector exists
      const clicked = await page.click(['#show-dynamic', '.nonexistent']);

      expect(clicked).toBe(true);
      await expectHasClass(page, '#dynamic', 'visible', true);
    });
  });

  test('should click using fallback selector', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      // First selector doesn't exist, second does
      const clicked = await page.click(['.nonexistent', '#show-dynamic']);

      expect(clicked).toBe(true);
      await expectHasClass(page, '#dynamic', 'visible', true);
    });
  });

  test('should return false for optional missing element', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      const clicked = await page.click('#does-not-exist', {
        optional: true,
        timeout: 1000,
      });

      expect(clicked).toBe(false);
    });
  });

  test('should throw for required missing element', async () => {
    const { page, baseUrl } = ctx.get();

    await page.goto(`${baseUrl}/basic.html`);

    await expect(page.click('#does-not-exist', { timeout: 1000 })).rejects.toThrow();
  });

  test('should click with all selectors failing until last', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      const clicked = await page.click([
        '#nope1',
        '#nope2',
        '.nope3',
        '[data-nope]',
        '#show-dynamic', // This one exists
      ]);

      expect(clicked).toBe(true);
      await expectHasClass(page, '#dynamic', 'visible', true);
    });
  });

  test('should open modal on click', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/modal.html`);

      // Modal should be closed initially
      const initiallyClosed = await page.evaluate(() => {
        const el = document.getElementById('modal-overlay');
        return el && !el.classList.contains('open');
      });
      expect(initiallyClosed).toBe(true);

      // Click to open
      await page.click('#open-modal');

      // Modal should be open
      await expectHasClass(page, '#modal-overlay', 'open', true);
    });
  });
});
