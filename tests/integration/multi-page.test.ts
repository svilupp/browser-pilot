/**
 * Multi-page flow integration tests
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { expectHasClass, expectPageUrl, expectTextContent } from '../utils/assertions';
import { withRetry } from '../utils/retry';
import { TestContext } from './setup';

// Each test file gets its own isolated context
const ctx = new TestContext();

describe('Multi-Page Wizard Flow', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  test('should complete step 1', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/multi-page/page1.html`);

      await page.fill('#first-name', 'John');
      await page.fill('#last-name', 'Doe');
      await page.fill('#email', 'john@example.com');

      // Set up navigation listener BEFORE clicking
      const navPromise = page.waitForNavigation({ timeout: 5000 });
      await page.click('#next-btn');
      await navPromise;

      await expectPageUrl(page, '/page2.html');
    });
  });

  test('should validate step 1 fields', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/multi-page/page1.html`);
      await page.click('#next-btn');
      await expectPageUrl(page, '/page1.html');
      await expectHasClass(page, '#first-name-error', 'visible', true);
    });
  });

  test('should complete step 2', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      // Complete step 1 first
      await page.goto(`${baseUrl}/multi-page/page1.html`);
      await page.fill('#first-name', 'Jane');
      await page.fill('#last-name', 'Smith');
      await page.fill('#email', 'jane@example.com');

      let navPromise = page.waitForNavigation({ timeout: 5000 });
      await page.click('#next-btn');
      await navPromise;

      // Now on step 2
      await expectPageUrl(page, '/page2.html');

      await page.fill('#street', '123 Main St');
      await page.fill('#city', 'New York');
      await page.fill('#zip', '10001');
      await page.select('#country', 'us');

      navPromise = page.waitForNavigation({ timeout: 5000 });
      await page.click('#next-btn');
      await navPromise;

      await expectPageUrl(page, '/page3.html');
    });
  });

  test('should go back from step 2 to step 1', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      // Complete step 1
      await page.goto(`${baseUrl}/multi-page/page1.html`);
      await page.fill('#first-name', 'Test');
      await page.fill('#last-name', 'User');
      await page.fill('#email', 'test@test.com');

      let navPromise = page.waitForNavigation({ timeout: 5000 });
      await page.click('#next-btn');
      await navPromise;

      // Go back
      navPromise = page.waitForNavigation({ timeout: 5000 });
      await page.click('#back-btn');
      await navPromise;

      await expectPageUrl(page, '/page1.html');
    });
  });

  test('should complete entire wizard', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      // Step 1
      await page.goto(`${baseUrl}/multi-page/page1.html`);
      await page.fill('#first-name', 'Complete');
      await page.fill('#last-name', 'Test');
      await page.fill('#email', 'complete@test.com');

      let navPromise = page.waitForNavigation({ timeout: 5000 });
      await page.click('#next-btn');
      await navPromise;

      // Step 2
      await page.fill('#street', '456 Oak Ave');
      await page.fill('#city', 'Los Angeles');
      await page.fill('#zip', '90001');
      await page.select('#country', 'us');

      navPromise = page.waitForNavigation({ timeout: 5000 });
      await page.click('#next-btn');
      await navPromise;

      // Step 3 - Verify summary
      await expectPageUrl(page, '/page3.html');
      await expectTextContent(page, 'Complete Test');
      await expectTextContent(page, '456 Oak Ave');
      await expectTextContent(page, 'Los Angeles');

      // Confirm
      await page.click('#confirm-btn');

      // Success should be visible
      await expectHasClass(page, '#success', 'visible', true);
      await expectTextContent(page, 'Success');
      await expectTextContent(page, 'CONF-');
    });
  });

  test('should complete wizard via batch actions', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      const step1 = await page.batch([
        { action: 'goto', url: `${baseUrl}/multi-page/page1.html` },
        { action: 'fill', selector: '#first-name', value: 'Batch' },
        { action: 'fill', selector: '#last-name', value: 'User' },
        { action: 'fill', selector: '#email', value: 'batch@user.com' },
        { action: 'click', selector: '#next-btn', waitForNavigation: true },
      ]);
      expect(step1.success).toBe(true);
    });
  });

  test('should redirect to step 1 if accessing step 2 directly', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      // Clear session storage first by going to page1 and resetting
      await page.goto(`${baseUrl}/multi-page/page1.html`);
      await page.evaluate(() => {
        sessionStorage.clear();
      });

      // Navigate to page2 - the page's script will check sessionStorage and redirect
      await page.goto(`${baseUrl}/multi-page/page2.html`);

      // Wait for redirect to complete (page2's script redirects if no wizard data)
      await page.waitForNavigation({ timeout: 5000, optional: true });

      await expectPageUrl(page, '/page1.html');
    });
  });
});
