/**
 * Form fill and submit integration tests
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { expectHasClass, expectInputValue, expectTextContent } from '../utils/assertions.ts';
import { withRetry } from '../utils/retry.ts';
import { TestContext } from './setup.ts';

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

  test('should clear and fill (always replaces)', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      // Fill initial value
      await page.fill('#name', 'Initial Value');
      await expectInputValue(page, '#name', 'Initial Value');

      // Fill again should replace (fill always selects all + replaces)
      await page.fill('#name', 'New Value');

      await expectInputValue(page, '#name', 'New Value');
    });
  });

  test('should clear a field to an empty string', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      await page.fill('#name', 'Will be cleared');
      await page.fill('#name', '');

      await expectInputValue(page, '#name', '');
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

      // Disable HTML5 validation and trigger form submission
      const errorMsg = await page.evaluate(() => {
        const form = document.getElementById('test-form') as HTMLFormElement;
        if (form) {
          form.setAttribute('novalidate', ''); // Bypass HTML5 validation
          form.requestSubmit();
        }
        // Wait for DOM update
        return new Promise<string>((resolve) => {
          setTimeout(() => {
            const result = document.getElementById('result');
            resolve(result?.textContent || '');
          }, 100);
        });
      });

      expect(errorMsg).toContain('Please enter your name');
    });
  });

  test('should show validation error for invalid email', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      await page.fill('#name', 'Test');
      await page.fill('#email', 'not-an-email');

      // Disable HTML5 validation and trigger form submission
      const errorMsg = await page.evaluate(() => {
        const form = document.getElementById('test-form') as HTMLFormElement;
        if (form) {
          form.setAttribute('novalidate', '');
          form.requestSubmit();
        }
        return new Promise<string>((resolve) => {
          setTimeout(() => {
            const result = document.getElementById('result');
            resolve(result?.textContent || '');
          }, 100);
        });
      });

      expect(errorMsg).toContain('valid email');
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

  test('should submit a form element directly via requestSubmit', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      await page.fill('#name', 'Form Element Submit');
      await page.fill('#email', 'form-element@test.com');
      await page.submit('#test-form', { waitForNavigation: false });

      await expectHasClass(page, '#result', 'success', true);
      await expectTextContent(page, 'Form submitted successfully');
    });
  });

  test('should submit form via Enter key', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      await page.fill('#name', 'Enter Test');
      await page.fill('#email', 'enter@test.com');

      // Submit form using requestSubmit (simulates Enter key submission)
      const result = await page.evaluate(() => {
        const form = document.getElementById('test-form') as HTMLFormElement;
        if (form) form.requestSubmit();
        return new Promise<{ hasSuccess: boolean; text: string }>((resolve) => {
          setTimeout(() => {
            const resultEl = document.getElementById('result');
            resolve({
              hasSuccess: resultEl?.classList.contains('success') ?? false,
              text: resultEl?.textContent || '',
            });
          }, 100);
        });
      });

      expect(result.hasSuccess).toBe(true);
      expect(result.text).toContain('Form submitted successfully');
    });
  });

  // === Fill Verification Modes ===

  test('exact verify (default) throws when an auto-formatter reshapes the value', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      let thrown: Error | null = null;
      try {
        await page.fill('#card-number', '4111111111111111');
      } catch (e) {
        thrown = e as Error;
      }
      expect(thrown).not.toBeNull();
      expect(thrown?.message).toMatch(/did not stick/);
    });
  });

  test('verify: "normalized" accepts auto-formatted whitespace differences', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      await page.fill('#card-number', '4111111111111111', { verify: 'normalized' });

      await expectInputValue(page, '#card-number', '4111 1111 1111 1111');
    });
  });

  test('verify: false skips verification for a formatted value', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      await page.fill('#card-number', '4111111111111111', { verify: false });

      await expectInputValue(page, '#card-number', '4111 1111 1111 1111');
    });
  });

  test('verify: "normalized" still throws when non-whitespace content is dropped', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      // The fixture's formatter strips non-digit characters, so requesting a
      // value with letters in it changes more than whitespace and must still
      // fail even under normalized verification.
      let thrown: Error | null = null;
      try {
        await page.fill('#card-number', 'abcd1111efgh2222', { verify: 'normalized' });
      } catch (e) {
        thrown = e as Error;
      }
      expect(thrown).not.toBeNull();
      expect(thrown?.message).toMatch(/did not stick/);
    });
  });

  test('fill via batch step passes through verify: "normalized"', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      const result = await page.batch([
        {
          action: 'fill',
          selector: '#card-number',
          value: '4111111111111111',
          verify: 'normalized',
        },
      ]);

      expect(result.success).toBe(true);
      await expectInputValue(page, '#card-number', '4111 1111 1111 1111');
    });
  });
});
