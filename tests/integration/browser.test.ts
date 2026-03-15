/**
 * Integration tests for browser automation
 * Uses TestContext for automatic Chrome lifecycle management
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { withRetry } from '../utils/retry.ts';
import { TestContext } from './setup.ts';

// Each test file gets its own isolated context
const ctx = new TestContext();

describe('Browser Integration', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  test('should connect to browser', () => {
    const { page } = ctx.get();
    // If we got here, browser is connected
    expect(page).toBeDefined();
  });

  test('should navigate to URL', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);
      const url = await page.url();

      expect(url).toContain('basic.html');
    });
  });

  test('should get page title', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);
      const title = await page.title();

      expect(title).toBe('Basic Test Page');
    });
  });

  test('should extract text content', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);
      const text = await page.text();

      expect(text).toContain('Basic Test Page');
      expect(text).toContain('test content');
    });
  });

  test('should take screenshot', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);
      const screenshot = await page.screenshot({ format: 'png' });

      // Should return base64 encoded PNG
      expect(typeof screenshot).toBe('string');
      expect(screenshot.length).toBeGreaterThan(100);
    });
  });

  test('should evaluate JavaScript', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      const result = await page.evaluate(() => {
        return document.querySelectorAll('p').length;
      });

      expect(result).toBeGreaterThan(0);
    });
  });

  test('should surface detailed evaluation errors', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      try {
        await page.evaluate('missingVariable.test');
        throw new Error('Expected evaluation to fail');
      } catch (error) {
        expect((error as Error).message).toContain('ReferenceError');
      }
    });
  });

  test('should wait for element', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      const found = await page.waitFor('h1', { timeout: 5000 });

      expect(found).toBe(true);
    });
  });

  test('should get accessibility snapshot', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);
      const snapshot = await page.snapshot();

      expect(snapshot.url).toContain('basic.html');
      expect(snapshot.title).toBe('Basic Test Page');
      expect(snapshot.accessibilityTree).toBeInstanceOf(Array);
      expect(snapshot.interactiveElements).toBeInstanceOf(Array);
      expect(typeof snapshot.text).toBe('string');
    });
  });

  test('should enumerate form fields with metadata', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/react-form.html`);
      const forms = await page.forms();

      expect(forms.length).toBeGreaterThan(0);
      expect(forms).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'username',
            label: 'Username (controlled)',
            type: 'text',
          }),
          expect.objectContaining({
            id: 'country',
            type: 'select',
            options: expect.arrayContaining([
              expect.objectContaining({ text: 'United States', value: 'us' }),
            ]),
          }),
        ])
      );
    });
  });

  test('should handle multi-selector click', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      // Try multiple selectors - one of them should work
      const clicked = await page.click(['#nonexistent', '.also-nonexistent', '#show-dynamic'], {
        optional: true,
        timeout: 5000,
      });

      expect(clicked).toBe(true);
    });
  });

  test('should click elements using text selectors', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      const clicked = await page.click('text:show dynamic content', { timeout: 5000 });

      expect(clicked).toBe(true);
      const visible = await page.evaluate(
        'document.getElementById("dynamic")?.classList.contains("visible")'
      );
      expect(visible).toBe(true);
    });
  });

  test('should click elements using role selectors', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      const clicked = await page.click('role:button:Show Dynamic Content', { timeout: 5000 });

      expect(clicked).toBe(true);
      const visible = await page.evaluate(
        'document.getElementById("dynamic")?.classList.contains("visible")'
      );
      expect(visible).toBe(true);
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

  test('should interact with form elements', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      // Fill the name input
      const filled = await page.fill('#name', 'hello world', { timeout: 5000 });
      expect(filled).toBe(true);

      // Verify the value was set
      const value = await page.evaluate(() => {
        const input = document.getElementById('name') as HTMLInputElement;
        return input?.value;
      });

      expect(value).toBe('hello world');
    });
  });

  // Navigation test last since it changes page state
  test('should click elements and navigate', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      const navPromise = page.waitForNavigation({ timeout: 2000, optional: true });

      // Click the form navigation link
      const clicked = await page.click('#nav-form', { optional: true, timeout: 5000 });

      if (clicked) {
        await navPromise;
        const url = await page.url();
        expect(url).toContain('form.html');
      }
    });
  }, 15000);
});
