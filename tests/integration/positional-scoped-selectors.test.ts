/**
 * Integration test (real Chrome) for deterministic disambiguation of N
 * identical-role elements WITHOUT vision.
 *
 * The fixture is an icon toolbar of 8 <button>s with no testid / label / text
 * (empty accessible name), each distinguished only by a unique `data-cmd`.
 * This exercises the full CDP path — parse → build expression → evaluateInFrame
 * → node resolution — for:
 *  - positional `role:button[N]` (Nth in DOM order),
 *  - container scoping via `within(<css>) …` and `<css> >> …`,
 *  - the configurable attribute allowlist turning a unique `data-cmd` into a
 *    high-confidence `[data-cmd="c2"]` candidate that resolves the right button.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { withRetry } from '../utils/retry.ts';
import { TestContext } from './setup.ts';

const ctx = new TestContext();

describe('positional + scoped special selectors (real Chrome)', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());

  test('role:button[N] clicks the Nth unnamed button in DOM order', async () => {
    const { page, baseUrl } = ctx.get();
    await withRetry(async () => {
      await page.goto(`${baseUrl}/icon-toolbar.html`);

      expect(await page.click('role:button[2]')).toBe(true);
      expect(await page.text('#clicked')).toBe('c2');

      expect(await page.click('role:button[5]')).toBe(true);
      expect(await page.text('#clicked')).toBe('c5');
    });
  }, 30000);

  test('elementState reports a positional selector as a single existing match', async () => {
    const { page, baseUrl } = ctx.get();
    await withRetry(async () => {
      await page.goto(`${baseUrl}/icon-toolbar.html`);

      const state = await page.elementState('role:button[3]');
      expect(state.exists).toBe(true);
      expect(state.count).toBe(1);

      // Out-of-range index resolves to nothing.
      const missing = await page.elementState('role:button[99]');
      expect(missing.exists).toBe(false);
      expect(missing.count).toBe(0);
    });
  }, 30000);

  test('container scope restricts the match set (within(...) and >>)', async () => {
    const { page, baseUrl } = ctx.get();
    await withRetry(async () => {
      await page.goto(`${baseUrl}/icon-toolbar.html`);

      // First button inside the SECOND toolbar is x1, not c1.
      expect(await page.click('within(.other) role:button[1]')).toBe(true);
      expect(await page.text('#clicked')).toBe('x1');

      // The >> form is equivalent.
      expect(await page.click('#other-toolbar >> role:button[2]')).toBe(true);
      expect(await page.text('#clicked')).toBe('x2');

      // Scoped to the first toolbar picks from c1..c8.
      expect(await page.click('within(.editor) role:button[3]')).toBe(true);
      expect(await page.text('#clicked')).toBe('c3');
    });
  }, 30000);

  test('resolveAll with testIdAttributes emits a unique [data-cmd] candidate that resolves', async () => {
    const { page, baseUrl } = ctx.get();
    await withRetry(async () => {
      await page.goto(`${baseUrl}/icon-toolbar.html`);

      const candidates = await page.resolveAll('c2', {
        testIdAttributes: ['data-cmd'],
        includeHidden: true,
      });
      const dataCmd = candidates.find((c) => c.selector === '[data-cmd="c2"]');
      expect(dataCmd).toBeDefined();
      expect(dataCmd?.strategy).toBe('testid');

      // And the generated selector actually resolves to the right button.
      expect(await page.click('[data-cmd="c2"]')).toBe(true);
      expect(await page.text('#clicked')).toBe('c2');
    });
  }, 30000);

  test('default resolveAll (no option) never fabricates a data-cmd candidate', async () => {
    const { page, baseUrl } = ctx.get();
    await withRetry(async () => {
      await page.goto(`${baseUrl}/icon-toolbar.html`);

      const candidates = await page.resolveAll('c2', { includeHidden: true });
      expect(candidates.some((c) => c.selector.includes('data-cmd'))).toBe(false);
    });
  }, 30000);
});
