/**
 * Inspect overlay integration tests
 *
 * Tests for visual ref overlay injection
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { injectRefOverlay, removeRefOverlay } from '../../src/browser/overlay';
import { withRetry } from '../utils/retry';
import { TestContext } from './setup';

// Each test file gets its own isolated context
const ctx = new TestContext();

describe('Inspect Overlay', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  describe('injectRefOverlay', () => {
    test('adds labels to page', async () => {
      const { page, baseUrl } = ctx.get();

      await withRetry(async () => {
        await page.goto(`${baseUrl}/form.html`);
        const snapshot = await page.snapshot();
        expect(snapshot.interactiveElements.length).toBeGreaterThan(0);

        await injectRefOverlay(page, snapshot);

        const containerExists = await page.evaluate(`
          !!document.getElementById('__bp-overlay-container')
        `);
        expect(containerExists).toBe(true);

        const styleExists = await page.evaluate(`
          !!document.getElementById('__bp-overlay-styles')
        `);
        expect(styleExists).toBe(true);

        const labelCount = await page.evaluate(`
          document.querySelectorAll('.__bp-ref-label').length
        `);
        expect(labelCount).toBeGreaterThan(0);

        await removeRefOverlay(page);
      });
    });

    test('positions labels near elements', async () => {
      const { page, baseUrl } = ctx.get();

      await withRetry(async () => {
        await page.goto(`${baseUrl}/form.html`);
        const snapshot = await page.snapshot();

        await injectRefOverlay(page, snapshot);

        const labelInfo = (await page.evaluate(`
          (function() {
            const label = document.querySelector('.__bp-ref-label');
            if (!label) return null;
            const style = label.style;
            return {
              left: style.left,
              top: style.top,
              text: label.textContent
            };
          })()
        `)) as { left: string; top: string; text: string } | null;

        expect(labelInfo).not.toBeNull();
        expect(labelInfo?.text).toMatch(/^e\d+$/);
        expect(labelInfo?.left).toMatch(/^\d+(\.\d+)?px$/);
        expect(labelInfo?.top).toMatch(/^-?\d+(\.\d+)?px$/);

        await removeRefOverlay(page);
      });
    });

    test('double-inject is idempotent', async () => {
      const { page, baseUrl } = ctx.get();

      await withRetry(async () => {
        await page.goto(`${baseUrl}/basic.html`);
        const snapshot = await page.snapshot();

        // Inject twice
        await injectRefOverlay(page, snapshot);
        await injectRefOverlay(page, snapshot);

        // Should only have one container
        const containerCount = await page.evaluate(`
          document.querySelectorAll('#__bp-overlay-container').length
        `);
        expect(containerCount).toBe(1);

        // Should only have one style tag
        const styleCount = await page.evaluate(`
          document.querySelectorAll('#__bp-overlay-styles').length
        `);
        expect(styleCount).toBe(1);

        await removeRefOverlay(page);
      });
    });

    test('adds data-bp-ref attributes to elements', async () => {
      const { page, baseUrl } = ctx.get();

      await withRetry(async () => {
        await page.goto(`${baseUrl}/form.html`);
        const snapshot = await page.snapshot();

        await injectRefOverlay(page, snapshot);

        const refCount = await page.evaluate(`
          document.querySelectorAll('[data-bp-ref]').length
        `);
        expect(refCount).toBeGreaterThan(0);

        const firstRef = await page.evaluate(`
          document.querySelector('[data-bp-ref]')?.getAttribute('data-bp-ref')
        `);
        expect(firstRef).toMatch(/^e\d+$/);

        await removeRefOverlay(page);
      });
    });
  });

  describe('removeRefOverlay', () => {
    test('removes container', async () => {
      const { page, baseUrl } = ctx.get();

      await withRetry(async () => {
        await page.goto(`${baseUrl}/form.html`);
        const snapshot = await page.snapshot();

        await injectRefOverlay(page, snapshot);

        const beforeRemove = await page.evaluate(`
          !!document.getElementById('__bp-overlay-container')
        `);
        expect(beforeRemove).toBe(true);

        await removeRefOverlay(page);

        const afterRemove = await page.evaluate(`
          !!document.getElementById('__bp-overlay-container')
        `);
        expect(afterRemove).toBe(false);
      });
    });

    test('removes injected styles', async () => {
      const { page, baseUrl } = ctx.get();

      await withRetry(async () => {
        await page.goto(`${baseUrl}/basic.html`);
        const snapshot = await page.snapshot();

        await injectRefOverlay(page, snapshot);

        const styleExists = await page.evaluate(`
          !!document.getElementById('__bp-overlay-styles')
        `);
        expect(styleExists).toBe(true);

        await removeRefOverlay(page);

        const styleGone = await page.evaluate(`
          !!document.getElementById('__bp-overlay-styles')
        `);
        expect(styleGone).toBe(false);
      });
    });

    test('removes data-bp-ref attributes', async () => {
      const { page, baseUrl } = ctx.get();

      await withRetry(async () => {
        await page.goto(`${baseUrl}/form.html`);
        const snapshot = await page.snapshot();

        await injectRefOverlay(page, snapshot);

        const beforeCount = await page.evaluate(`
          document.querySelectorAll('[data-bp-ref]').length
        `);
        expect(beforeCount).toBeGreaterThan(0);

        await removeRefOverlay(page);

        const afterCount = await page.evaluate(`
          document.querySelectorAll('[data-bp-ref]').length
        `);
        expect(afterCount).toBe(0);
      });
    });

    test('allows reinstallation after removal', async () => {
      const { page, baseUrl } = ctx.get();

      await withRetry(async () => {
        await page.goto(`${baseUrl}/basic.html`);
        const snapshot = await page.snapshot();

        // First injection
        await injectRefOverlay(page, snapshot);

        // Remove
        await removeRefOverlay(page);

        // Should be able to inject again
        await injectRefOverlay(page, snapshot);

        const containerExists = await page.evaluate(`
          !!document.getElementById('__bp-overlay-container')
        `);
        expect(containerExists).toBe(true);

        // Clean up
        await removeRefOverlay(page);
      });
    });
  });
});
