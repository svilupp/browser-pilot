import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from '../../src';
import { createTestHarness, destroyHarness, type TestHarness } from '../utils/harness';

let harness: TestHarness;
let browser: Browser;
let baseUrl: string;

describe('Multi-tab browser operations', () => {
  beforeAll(async () => {
    harness = await createTestHarness();
    browser = harness.browser;
    baseUrl = harness.baseUrl;
  });

  afterAll(async () => {
    await destroyHarness(harness);
  });

  test('closePage closes the named target instead of the first target', async () => {
    const pageOne: Page = await browser.newPage(`${baseUrl}/basic.html`);
    const pageTwo: Page = await browser.newPage(`${baseUrl}/form.html`);

    const targetsBefore = await browser.listTargets();
    expect(targetsBefore.some((target) => target.targetId === pageOne.targetId)).toBe(true);
    expect(targetsBefore.some((target) => target.targetId === pageTwo.targetId)).toBe(true);

    await browser.closePage('page-2');

    const targetsAfter = await browser.listTargets();
    expect(targetsAfter.some((target) => target.targetId === pageOne.targetId)).toBe(true);
    expect(targetsAfter.some((target) => target.targetId === pageTwo.targetId)).toBe(false);
  });

  test('closePage ignores unknown names', async () => {
    const before = await browser.listTargets();
    await browser.closePage('missing-page');
    const after = await browser.listTargets();

    expect(after.map((target) => target.targetId)).toEqual(before.map((target) => target.targetId));
  });
});
