/**
 * Snapshot and screenshot integration tests
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { withRetry } from '../utils/retry';
import { TestContext } from './setup';

// Each test file gets its own isolated context
const ctx = new TestContext();

describe('Snapshot and Screenshot', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  // === Page Snapshot Tests ===

  test('should get page snapshot', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      const snapshot = await page.snapshot();

      expect(snapshot.url).toContain('/form.html');
      expect(snapshot.title).toBe('Form Test Page');
      expect(snapshot.timestamp).toBeTruthy();
      expect(snapshot.accessibilityTree).toBeInstanceOf(Array);
      expect(snapshot.interactiveElements).toBeInstanceOf(Array);
      expect(typeof snapshot.text).toBe('string');
    });
  });

  test('should identify interactive elements', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      const snapshot = await page.snapshot();

      // Should find form inputs
      const hasTextbox = snapshot.interactiveElements.some((e) => e.role === 'textbox');
      const hasButton = snapshot.interactiveElements.some((e) => e.role === 'button');

      expect(hasTextbox).toBe(true);
      expect(hasButton).toBe(true);
    });
  });

  test('should have unique refs for elements', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      const snapshot = await page.snapshot();

      const refs = snapshot.interactiveElements.map((e) => e.ref);
      const uniqueRefs = new Set(refs);

      // All refs should be unique
      expect(refs.length).toBe(uniqueRefs.size);
    });
  });

  test('should include element selectors', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      const snapshot = await page.snapshot();

      // Elements should have selectors
      const elementsWithSelectors = snapshot.interactiveElements.filter(
        (e) => e.selector && e.selector.length > 0
      );

      expect(elementsWithSelectors.length).toBeGreaterThan(0);
    });
  });

  test('should get text representation', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      const snapshot = await page.snapshot();

      // Text should contain page content
      expect(snapshot.text).toContain('Basic Test Page');
    });
  });

  // === Screenshot Tests ===

  test('should take PNG screenshot', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      const screenshot = await page.screenshot({ format: 'png' });

      expect(typeof screenshot).toBe('string');
      expect(screenshot.length).toBeGreaterThan(100);

      // Should be valid base64
      const decoded = Buffer.from(screenshot, 'base64');
      expect(decoded.length).toBeGreaterThan(100);
    });
  });

  test('should take JPEG screenshot', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      const screenshot = await page.screenshot({ format: 'jpeg', quality: 80 });

      expect(typeof screenshot).toBe('string');
      expect(screenshot.length).toBeGreaterThan(100);
    });
  });

  test('should take full page screenshot', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/checkboxes.html`);

      const screenshot = await page.screenshot({ format: 'png', fullPage: true });

      expect(typeof screenshot).toBe('string');
      expect(screenshot.length).toBeGreaterThan(100);
    });
  });

  // === Text Extraction Tests ===

  test('should extract all text from page', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      const text = await page.text();

      expect(text).toContain('Basic Test Page');
      expect(text).toContain('test content');
      expect(text).toContain('multiple paragraphs');
    });
  });

  test('should extract text from selector', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      const text = await page.text('.content');

      expect(text).toContain('test content');
    });
  });

  test('should extract text after dynamic content appears', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      // Click to show dynamic content
      await page.click('#show-dynamic');

      // Extract text
      const text = await page.text();

      expect(text).toContain('Dynamic content loaded');
    });
  });
});
