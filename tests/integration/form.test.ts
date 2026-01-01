/**
 * Form fill and submit integration tests
 */

import { afterAll, afterEach, beforeAll, describe, test } from 'bun:test';
import { expectHasClass, expectInputValue, expectTextContent } from '../utils/assertions';
import { withRetry } from '../utils/retry';
import { TestContext } from './setup';

// Each test file gets its own isolated context
const ctx = new TestContext();

describe('Form Fill and Submit Actions', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  // === Form Fill Tests ===

  test('should fill an input field', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      await page.fill('#name', 'John Doe');

      await expectInputValue(page, '#name', 'John Doe');
    });
  });

  test('should fill multiple fields', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      await page.fill('#name', 'Jane Smith');
      await page.fill('#email', 'jane@example.com');
      await page.fill('#phone', '555-1234');
      await page.fill('#message', 'Hello, world!');

      await expectInputValue(page, '#name', 'Jane Smith');
      await expectInputValue(page, '#email', 'jane@example.com');
      await expectInputValue(page, '#phone', '555-1234');
      await expectInputValue(page, '#message', 'Hello, world!');
    });
  });

  test('should clear and fill with { clear: true }', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      // Fill initial value
      await page.fill('#name', 'Initial Value');
      await expectInputValue(page, '#name', 'Initial Value');

      // Fill with clear should replace
      await page.fill('#name', 'New Value', { clear: true });

      await expectInputValue(page, '#name', 'New Value');
    });
  });

  test('should fill using multi-selector', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      // Use multiple selectors - name field
      await page.fill(['#nonexistent', '#name', '.backup'], 'Multi Selector Test');

      await expectInputValue(page, '#name', 'Multi Selector Test');
    });
  });

  test('should submit form and show success', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      await page.fill('#name', 'Test User');
      await page.fill('#email', 'test@example.com');
      await page.click('#submit-btn');

      // Check for success message
      await expectHasClass(page, '#result', 'success', true);
      await expectTextContent(page, 'Form submitted successfully');
      await expectTextContent(page, 'Test User');
    });
  });

  test('should show validation error for empty name', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      // Fill email but not name
      await page.fill('#email', 'test@example.com');
      await page.click('#submit-btn');

      await expectHasClass(page, '#result', 'error', true);
      await expectTextContent(page, 'Please enter your name');
    });
  });

  test('should show validation error for invalid email', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      await page.fill('#name', 'Test');
      await page.fill('#email', 'not-an-email');
      await page.click('#submit-btn');

      await expectHasClass(page, '#result', 'error', true);
      await expectTextContent(page, 'valid email');
    });
  });

  // === Form Submit Tests ===

  test('should submit form via submit method', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      await page.fill('#name', 'Submit Test');
      await page.fill('#email', 'submit@test.com');
      await page.submit('#submit-btn');

      await expectHasClass(page, '#result', 'success', true);
    });
  });

  test('should submit form via Enter key', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      await page.fill('#name', 'Enter Test');
      await page.fill('#email', 'enter@test.com');

      // Focus on email and press Enter
      await page.focus('#email');
      await page.press('Enter');

      await expectHasClass(page, '#result', 'success', true);
    });
  });
});
