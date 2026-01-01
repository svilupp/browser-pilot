/**
 * Custom assertions for page state validation
 */

import { expect } from 'bun:test';
import type { Page } from '../../src';

/**
 * Assert page URL contains or matches expected value
 */
export async function expectPageUrl(page: Page, expected: string | RegExp): Promise<void> {
  const url = await page.url();
  if (typeof expected === 'string') {
    expect(url).toContain(expected);
  } else {
    expect(url).toMatch(expected);
  }
}

/**
 * Assert page title matches expected value
 */
export async function expectPageTitle(page: Page, expected: string | RegExp): Promise<void> {
  const title = await page.title();
  if (typeof expected === 'string') {
    expect(title).toBe(expected);
  } else {
    expect(title).toMatch(expected);
  }
}

/**
 * Assert page text content contains expected string
 */
export async function expectTextContent(page: Page, text: string): Promise<void> {
  const content = await page.text();
  expect(content).toContain(text);
}

/**
 * Assert element is visible on page
 */
export async function expectElementVisible(
  page: Page,
  selector: string,
  timeout = 2000
): Promise<void> {
  const found = await page.waitFor(selector, { timeout, state: 'visible' });
  expect(found).toBe(true);
}

/**
 * Assert element is hidden or not present
 */
export async function expectElementHidden(
  page: Page,
  selector: string,
  timeout = 2000
): Promise<void> {
  const found = await page.waitFor(selector, {
    timeout,
    state: 'hidden',
    optional: true,
  });
  expect(found).toBe(true);
}

/**
 * Assert element does not exist in DOM
 */
export async function expectElementNotExists(page: Page, selector: string): Promise<void> {
  const exists = await page.evaluate((sel: string) => {
    return document.querySelector(sel) !== null;
  }, selector);
  expect(exists).toBe(false);
}

/**
 * Assert input element has expected value
 */
export async function expectInputValue(
  page: Page,
  selector: string,
  expected: string
): Promise<void> {
  const value = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLInputElement;
    return el?.value ?? null;
  }, selector);
  expect(value).toBe(expected);
}

/**
 * Assert checkbox/radio is checked or unchecked
 */
export async function expectChecked(page: Page, selector: string, checked: boolean): Promise<void> {
  const isChecked = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLInputElement;
    return el?.checked ?? false;
  }, selector);
  expect(isChecked).toBe(checked);
}

/**
 * Assert select element has expected value
 */
export async function expectSelectedValue(
  page: Page,
  selector: string,
  expected: string
): Promise<void> {
  const value = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLSelectElement;
    return el?.value ?? null;
  }, selector);
  expect(value).toBe(expected);
}

/**
 * Assert element has expected text content
 */
export async function expectElementText(
  page: Page,
  selector: string,
  expected: string | RegExp
): Promise<void> {
  const text = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    return el?.textContent?.trim() ?? null;
  }, selector);

  if (typeof expected === 'string') {
    expect(text).toBe(expected);
  } else {
    expect(text).toMatch(expected);
  }
}

/**
 * Assert element has expected attribute value
 */
export async function expectAttribute(
  page: Page,
  selector: string,
  attribute: string,
  expected: string | null
): Promise<void> {
  const value = await page.evaluate(
    (sel: string, attr: string) => {
      const el = document.querySelector(sel);
      return el?.getAttribute(attr) ?? null;
    },
    selector,
    attribute
  );
  expect(value).toBe(expected);
}

/**
 * Assert element has expected CSS class
 */
export async function expectHasClass(
  page: Page,
  selector: string,
  className: string,
  hasClass = true
): Promise<void> {
  const result = await page.evaluate(
    (sel: string, cls: string) => {
      const el = document.querySelector(sel);
      return el?.classList.contains(cls) ?? false;
    },
    selector,
    className
  );
  expect(result).toBe(hasClass);
}

/**
 * Assert number of elements matching selector
 */
export async function expectElementCount(
  page: Page,
  selector: string,
  count: number
): Promise<void> {
  const actual = await page.evaluate((sel: string) => {
    return document.querySelectorAll(sel).length;
  }, selector);
  expect(actual).toBe(count);
}
