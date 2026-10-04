import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  type CrossOriginHarness,
  createCrossOriginHarness,
  destroyCrossOriginHarness,
} from '../utils/cross-origin-harness.ts';

let harness: CrossOriginHarness;
beforeAll(async () => {
  harness = await createCrossOriginHarness();
});
afterAll(async () => {
  if (harness) await destroyCrossOriginHarness(harness);
});

test('shared fixture verifies parent/child input isolation, SPA content and PNG effects', async () => {
  const page = await harness.browser.page();
  const url = new URL('/cloudflare-conformance.html', harness.parentOrigin);
  url.searchParams.set('childOrigin', harness.childOrigin);
  await page.goto(url.href);
  expect(await page.text('#identity')).toBe('Parent fixture v1');
  await page.fill('#value', 'parent-only', { timeout: 5000 });
  await page.click('#click', { timeout: 5000 });
  expect(await page.text('#count')).toBe('1');
  await page.click('#route', { timeout: 5000 });
  await page.waitFor('#spa-ready', { timeout: 5000 });
  expect(await page.text('#spa-ready')).toBe('Next content v1');
  await page.switchToFrame('#child', { timeout: 10000 });
  expect(await page.text('#identity')).toBe('Child fixture v1');
  await page.fill('#value', 'child-only', { timeout: 5000 });
  await page.switchToMain();
  expect(await page.evaluate<string>('document.querySelector("#value").value')).toBe('parent-only');
  expect(await page.text('#child-result')).toBe('child-only');
  const bytes = Buffer.from(await page.screenshot({ format: 'png' }), 'base64');
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
}, 30000);
