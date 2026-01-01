/**
 * Navigation integration tests
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { expectPageTitle, expectPageUrl, expectTextContent } from '../utils/assertions';
import { withRetry } from '../utils/retry';
import { TestContext } from './setup';

// Each test file gets its own isolated context
const ctx = new TestContext();

describe('Navigation', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  test('should navigate to a URL', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      await expectPageUrl(page, '/basic.html');
      await expectPageTitle(page, 'Basic Test Page');
    });
  });

  test('should get page URL', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      const url = await page.url();
      expect(url).toContain('/form.html');
    });
  });

  test('should get page title', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      const title = await page.title();
      expect(title).toBe('Form Test Page');
    });
  });

  test('should extract text content', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      await expectTextContent(page, 'This is test content');
      await expectTextContent(page, 'multiple paragraphs');
    });
  });

  test('should reload page', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      // Click to show dynamic content
      await page.click('#show-dynamic');

      // Reload should reset
      await page.reload();

      // Dynamic content should be hidden again
      const isHidden = await page.evaluate(() => {
        const el = document.getElementById('dynamic');
        return el && !el.classList.contains('visible');
      });
      expect(isHidden).toBe(true);
    });
  });

  test('should navigate back and forward', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);
      await page.goto(`${baseUrl}/form.html`);

      // Go back
      await page.goBack();
      await expectPageUrl(page, '/basic.html');

      // Go forward
      await page.goForward();
      await expectPageUrl(page, '/form.html');
    });
  });

  test('should wait for navigation after link click', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      // Set up navigation listener BEFORE clicking (correct pattern)
      const navPromise = page.waitForNavigation({ timeout: 5000 });

      // Click navigation link
      await page.click('#nav-form');

      // Wait for navigation to complete
      await navPromise;
      await expectPageUrl(page, '/form.html');
    });
  });
});
