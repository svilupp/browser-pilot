/**
 * click() must produce real user-click semantics on interactive form controls:
 * a checkbox/radio toggles .checked AND fires bubbling input + change (exactly
 * once, in the correct order) — the same as a genuine user click. Plain element
 * clicks (buttons) must be unaffected.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Page } from '../../src/index.ts';
import { withRetry } from '../utils/retry.ts';
import { TestContext } from './setup.ts';

const ctx = new TestContext();

async function text(page: Page, id: string): Promise<string> {
  return await page.evaluate((sel: string) => document.getElementById(sel)?.textContent ?? '', id);
}

async function checked(page: Page, id: string): Promise<boolean> {
  return await page.evaluate(
    (sel: string) => (document.getElementById(sel) as HTMLInputElement).checked,
    id
  );
}

describe('click() form-control semantics', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  test('click on a checkbox flips .checked and fires change once', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/click-semantics.html`);

      // First click: toggles on, change-driven UI updates, exactly one input+change.
      await page.click('#cb');
      expect(await checked(page, 'cb')).toBe(true);
      expect(await text(page, 'cb-status')).toBe('checked');
      expect(await text(page, 'cb-change-count')).toBe('1'); // no double-toggle
      expect(await text(page, 'cb-input-count')).toBe('1');

      // Second click: toggles back off, one more change (total 2).
      await page.click('#cb');
      expect(await checked(page, 'cb')).toBe(false);
      expect(await text(page, 'cb-status')).toBe('unchecked');
      expect(await text(page, 'cb-change-count')).toBe('2');
    });
  });

  test('click on a radio option selects it and fires change', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/click-semantics.html`);

      await page.click('#r2');
      expect(await checked(page, 'r2')).toBe(true);
      expect(await checked(page, 'r1')).toBe(false);
      expect(await text(page, 'radio-status')).toBe('two');
      expect(await text(page, 'radio-change-count')).toBe('1');

      // Switching selection fires change on the newly-selected radio.
      await page.click('#r3');
      expect(await checked(page, 'r3')).toBe(true);
      expect(await checked(page, 'r2')).toBe(false);
      expect(await text(page, 'radio-status')).toBe('three');
      expect(await text(page, 'radio-change-count')).toBe('2');
    });
  });

  test('click recovers when the input itself is not pointer-hittable', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/click-semantics.html`);

      // #pen has pointer-events:none; a real user drives it via its label.
      // click() must still end up checked with change fired.
      await page.click('#pen');
      expect(await checked(page, 'pen')).toBe(true);
      expect(await text(page, 'pen-status')).toBe('checked');
    });
  });

  test('click on a plain button still fires its click handler (no regression)', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/click-semantics.html`);

      await page.click('#btn');
      expect(await text(page, 'btn-status')).toBe('clicked');
      expect(await text(page, 'btn-click-count')).toBe('1'); // fired exactly once
    });
  });
});
