/**
 * Integration test (real Chrome) for findElement candidate ORDER.
 *
 * Two buttons share the same accessible name ("Add to cart") but have distinct
 * data-testid attributes. After a snapshot, the caller passes an ordered
 * candidate array whose LEADING hint is the unique testid for button #1, while a
 * competing `ref:` for button #2 also appears in the array. findElement must
 * honor array order and act on button #1 — the historical bug hoisted the ref
 * and clicked button #2.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { InteractiveElement } from '../../src/index.ts';
import { withRetry } from '../utils/retry.ts';
import { TestContext } from './setup.ts';

const ctx = new TestContext();

function refByTestId(elements: InteractiveElement[], testId: string): string | undefined {
  return elements.find((e) => e.attributes?.['data-testid'] === testId)?.ref;
}

describe('findElement honors candidate order (real Chrome)', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());

  test('leading testid wins over a competing ref for a same-named button', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/duplicate-buttons.html`);

      // Snapshot with attributes so we can locate each button's ref by testid.
      const snapshot = await page.snapshot({ attributes: true });

      const keyboardRef = refByTestId(snapshot.interactiveElements, 'add-p-keyboard');
      const headphonesRef = refByTestId(snapshot.interactiveElements, 'add-p-headphones');
      expect(keyboardRef).toBeDefined();
      expect(headphonesRef).toBeDefined();

      // Ordered array: the unique testid for the KEYBOARD button leads, but a
      // competing ref for the HEADPHONES button follows (plus broad fallbacks).
      const clicked = await page.click([
        "[data-testid='add-p-keyboard']",
        `ref:${headphonesRef}`,
        "[data-testid='add-p-headphones']",
        'role:button:Add to cart',
      ]);
      expect(clicked).toBe(true);
      // Capture immediately — later findElement calls (e.g. page.text) reset this.
      const matched = page.getLastMatchedSelector();
      expect(matched).toBe("[data-testid='add-p-keyboard']");

      // The leading testid must have won — keyboard, NOT headphones.
      const which = await page.text('#clicked');
      expect(which).toBe('keyboard');
    });
  }, 30000);
});
