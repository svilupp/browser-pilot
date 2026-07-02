/**
 * Integration tests for Page.elementState (real Chrome).
 *
 * Exercises the primary use case: inspecting arbitrary, non-interactive DOM
 * containers (that snapshot() never surfaces) by CSS selector.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { withRetry } from '../utils/retry.ts';
import { TestContext } from './setup.ts';

const ctx = new TestContext();

describe('Page.elementState', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  test('reports a present + visible non-interactive container', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      // `.content` is a non-interactive <p> — not in the accessibility snapshot.
      const state = await page.elementState('.content');

      expect(state.exists).toBe(true);
      expect(state.visible).toBe(true);
      expect(state.count).toBe(2); // two <p class="content"> paragraphs
      expect(state.text).toContain('test content');
      expect(state.value).toBeNull(); // <p> is not a form control
      expect(state.boundingBox).not.toBeNull();
      expect(state.boundingBox!.width).toBeGreaterThan(0);
      expect(state.boundingBox!.height).toBeGreaterThan(0);
    });
  });

  test('reports a present-but-hidden element (display:none)', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      // #dynamic starts hidden via `display: none`.
      const state = await page.elementState('#dynamic');

      expect(state.exists).toBe(true);
      expect(state.visible).toBe(false);
      expect(state.count).toBe(1);
      expect(state.boundingBox).toBeNull();
    });
  });

  test('reports a missing element', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      const state = await page.elementState('[data-testid="not-here"]');

      expect(state.exists).toBe(false);
      expect(state.visible).toBe(false);
      expect(state.count).toBe(0);
      expect(state.text).toBe('');
      expect(state.value).toBeNull();
      expect(state.boundingBox).toBeNull();
    });
  });

  test('reports the form-control value of a <select> (string), null for a non-form div', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/dropdown.html`);

      // Give the native <select> a concrete value, then read it back.
      await page.evaluate(() => {
        const el = document.getElementById('native-select') as HTMLSelectElement | null;
        if (el) el.value = 'ca';
      });

      const select = await page.elementState('#native-select');
      expect(select.exists).toBe(true);
      expect(typeof select.value).toBe('string');
      expect(select.value).toBe('ca');

      // A container <div> is not a form control -> value is null.
      const div = await page.elementState('#custom-dropdown');
      expect(div.exists).toBe(true);
      expect(div.value).toBeNull();
    });
  });

  test('pierces shadow roots to find an element inside a shadow DOM', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/shadow-dom.html`);

      // <simple-button> attaches an open shadow root containing the only
      // [data-testid="shadow-button"] on the page — light-DOM querySelectorAll
      // can't see it, so this exercises deepQueryAll's shadow-root recursion.
      const state = await page.elementState('[data-testid="shadow-button"]');

      expect(state.exists).toBe(true);
      expect(state.count).toBe(1);
      expect(state.visible).toBe(true);
      expect(state.text).toContain('Click me');
      expect(state.boundingBox).not.toBeNull();
      expect(state.boundingBox!.width).toBeGreaterThan(0);
      expect(state.boundingBox!.height).toBeGreaterThan(0);
    });
  }, 30000);

  test('returns an empty state (no throw) for a malformed selector', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      // "[" is not a valid CSS selector; querySelectorAll would throw a
      // SyntaxError. elementState must swallow it and report an empty state.
      const state = await page.elementState('[');

      expect(state.exists).toBe(false);
      expect(state.count).toBe(0);
      expect(state.visible).toBe(false);
      expect(state.boundingBox).toBeNull();
      expect(state.value).toBeNull();
      expect(state.text).toBe('');
    });
  });
});
