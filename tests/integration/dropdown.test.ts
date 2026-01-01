/**
 * Dropdown selection integration tests
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { expectHasClass, expectSelectedValue } from '../utils/assertions';
import { withRetry } from '../utils/retry';
import { TestContext } from './setup';

// Each test file gets its own isolated context
const ctx = new TestContext();

describe('Dropdown Selection', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  // === Native Dropdown Tests ===

  test('should select from native dropdown', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/dropdown.html`);

      await page.select('#native-select', 'uk');

      await expectSelectedValue(page, '#native-select', 'uk');
    });
  });

  test('should select different values', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/dropdown.html`);

      // Select first value
      await page.select('#native-select', 'us');
      await expectSelectedValue(page, '#native-select', 'us');

      // Change selection
      await page.select('#native-select', 'ca');
      await expectSelectedValue(page, '#native-select', 'ca');

      // Change again
      await page.select('#native-select', 'jp');
      await expectSelectedValue(page, '#native-select', 'jp');
    });
  });

  test('should update display when selecting', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/dropdown.html`);

      await page.select('#native-select', 'de');

      // Check the status display updated
      const displayText = await page.evaluate(() => {
        return document.getElementById('native-value')?.textContent || '';
      });
      expect(displayText).toContain('Germany');
    });
  });

  // === Custom Searchable Dropdown Tests ===

  test('should open custom dropdown', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/dropdown.html`);

      // Click to open
      await page.click('#dropdown-trigger');

      // Menu should be visible
      await expectHasClass(page, '#dropdown-menu', 'open', true);
    });
  });

  test('should select from custom dropdown by clicking', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/dropdown.html`);

      // Open dropdown
      await page.click('#dropdown-trigger');

      // Click an option
      await page.click('.dropdown-option[data-value="fr"]');

      // Menu should close
      await expectHasClass(page, '#dropdown-menu', 'open', false);

      // Value should be updated
      const displayText = await page.evaluate(() => {
        return document.getElementById('custom-value')?.textContent || '';
      });
      expect(displayText).toContain('France');
    });
  });

  test('should search and filter options', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/dropdown.html`);

      // Open dropdown
      await page.click('#dropdown-trigger');

      // Type in search
      await page.fill('#dropdown-search', 'United');

      // Check that non-matching options are hidden
      const visibleOptions = await page.evaluate(() => {
        const options = document.querySelectorAll('.dropdown-option:not(.hidden)');
        return Array.from(options).map((o) => o.textContent);
      });

      expect(visibleOptions).toContain('United States');
      expect(visibleOptions).toContain('United Kingdom');
      expect(visibleOptions.length).toBe(2);
    });
  });

  test('should search and select option', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/dropdown.html`);

      // Compose from primitives
      await page.click('#dropdown-trigger');
      await page.fill('#dropdown-search', 'Japan');
      await page.click('.dropdown-option[data-value="jp"]');

      // Verify selection
      const displayText = await page.evaluate(() => {
        return document.getElementById('custom-value')?.textContent || '';
      });
      expect(displayText).toContain('Japan');
    });
  });

  test('should handle custom select config', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/dropdown.html`);

      // Use custom select config (if implemented)
      // For now, test via composition
      await page.click('#dropdown-trigger');

      // Wait for menu
      await page.waitFor('#dropdown-menu.open', { timeout: 2000 });

      // Select by text content
      const options = await page.evaluate(() => {
        const opts = document.querySelectorAll('.dropdown-option');
        for (const opt of opts) {
          if (opt.textContent === 'Brazil') {
            (opt as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      expect(options).toBe(true);

      // Verify
      const value = await page.evaluate(() => {
        return document.getElementById('custom-value')?.textContent || '';
      });
      expect(value).toContain('Brazil');
    });
  });
});
