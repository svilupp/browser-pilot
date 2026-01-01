/**
 * Integration tests for browser automation
 * Requires a Chrome instance running with --remote-debugging-port=9222
 *
 * To run:
 * 1. Start Chrome with debugging:
 *    /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --headless=new
 * 2. Run tests:
 *    bun test tests/integration
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Browser, connect, getBrowserWebSocketUrl, type Page } from '../../src/index.ts';

// Check if browser is available
async function isBrowserAvailable(): Promise<boolean> {
  try {
    await getBrowserWebSocketUrl('localhost:9222');
    return true;
  } catch {
    return false;
  }
}

describe('Browser Integration', () => {
  let browser: Browser;
  let page: Page;
  let skipTests = false;

  beforeAll(async () => {
    skipTests = !(await isBrowserAvailable());
    if (skipTests) {
      console.log('⚠️  Skipping integration tests - no browser available at localhost:9222');
      return;
    }

    const wsUrl = await getBrowserWebSocketUrl('localhost:9222');
    browser = await connect({
      provider: 'generic',
      wsUrl,
      debug: false,
    });
    page = await browser.page();
  });

  afterAll(async () => {
    if (browser) {
      await browser.disconnect();
    }
  });

  test('should connect to browser', () => {
    if (skipTests) return;
    expect(browser.isConnected).toBe(true);
  });

  test('should navigate to URL', async () => {
    if (skipTests) return;

    await page.goto('https://example.com');
    const url = await page.url();

    expect(url).toContain('example.com');
  });

  test('should get page title', async () => {
    if (skipTests) return;

    await page.goto('https://example.com');
    const title = await page.title();

    expect(title).toBe('Example Domain');
  });

  test('should extract text content', async () => {
    if (skipTests) return;

    await page.goto('https://example.com');
    const text = await page.text();

    expect(text).toContain('Example Domain');
    expect(text).toContain('domain');
  });

  test('should take screenshot', async () => {
    if (skipTests) return;

    await page.goto('https://example.com');
    const screenshot = await page.screenshot({ format: 'png' });

    // Should return base64 encoded PNG
    expect(typeof screenshot).toBe('string');
    expect(screenshot.length).toBeGreaterThan(100);
  });

  test('should evaluate JavaScript', async () => {
    if (skipTests) return;

    await page.goto('https://example.com');

    const result = await page.evaluate(() => {
      return document.querySelectorAll('p').length;
    });

    expect(result).toBeGreaterThan(0);
  });

  test('should wait for element', async () => {
    if (skipTests) return;

    await page.goto('https://example.com');

    const found = await page.waitFor('h1', { timeout: 5000 });

    expect(found).toBe(true);
  });

  test('should get accessibility snapshot', async () => {
    if (skipTests) return;

    await page.goto('https://example.com');
    const snapshot = await page.snapshot();

    expect(snapshot.url).toContain('example.com');
    expect(snapshot.title).toBe('Example Domain');
    expect(snapshot.accessibilityTree).toBeInstanceOf(Array);
    expect(snapshot.interactiveElements).toBeInstanceOf(Array);
    expect(typeof snapshot.text).toBe('string');
  });

  test('should click elements and navigate', async () => {
    if (skipTests) return;

    await page.goto('https://example.com');

    // Example.com has a link - click it
    const clicked = await page.click('a', { optional: true, timeout: 5000 });

    if (clicked) {
      // If we clicked, we should navigate to IANA
      await page.waitForNavigation({ timeout: 10000, optional: true });
      const url = await page.url();
      expect(url).toContain('iana.org');
    }
  });

  test('should handle multi-selector click', async () => {
    if (skipTests) return;

    await page.goto('https://example.com');

    // Try multiple selectors - one of them should work
    const clicked = await page.click(['#nonexistent', '.also-nonexistent', 'a'], {
      optional: true,
      timeout: 5000,
    });

    expect(clicked).toBe(true);
  });

  test('should return false for optional missing element', async () => {
    if (skipTests) return;

    await page.goto('https://example.com');

    const clicked = await page.click('#does-not-exist', {
      optional: true,
      timeout: 1000,
    });

    expect(clicked).toBe(false);
  });
});

describe('Search Engine Test', () => {
  let browser: Browser;
  let page: Page;
  let skipTests = false;

  beforeAll(async () => {
    skipTests = !(await isBrowserAvailable());
    if (skipTests) return;

    const wsUrl = await getBrowserWebSocketUrl('localhost:9222');
    browser = await connect({
      provider: 'generic',
      wsUrl,
      debug: false,
    });
    page = await browser.page();
  });

  afterAll(async () => {
    if (browser) {
      await browser.disconnect();
    }
  });

  test('should interact with form elements', async () => {
    if (skipTests) return;

    // Use a simpler test that just verifies form interactions work
    await page.goto('https://example.com');

    // Verify we can evaluate JS to interact with elements
    const result = await page.evaluate(() => {
      const el = document.createElement('input');
      el.id = 'test-input';
      el.type = 'text';
      document.body.appendChild(el);
      return el.id;
    });

    expect(result).toBe('test-input');

    // Fill the input we just created
    const filled = await page.fill('#test-input', 'hello world', { timeout: 5000 });
    expect(filled).toBe(true);

    // Verify the value was set
    const value = await page.evaluate(() => {
      const input = document.getElementById('test-input') as HTMLInputElement;
      return input?.value;
    });

    expect(value).toBe('hello world');
  }, 30000);
});
