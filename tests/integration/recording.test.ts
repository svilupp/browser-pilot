/**
 * Recording integration tests
 *
 * Tests the full recording flow with a real browser:
 * - Script injection and event capture
 * - Click action recording with selectors
 * - Input recording with values
 * - Password field redaction
 * - Multi-selector array ordering
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Recorder } from '../../src/recording/recorder.ts';
import { waitUntil, withRetry } from '../utils/retry';
import { TestContext } from './setup';

const ctx = new TestContext();

describe('Recording Integration', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  test('should record click action with selectors', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      // Start recording
      const recorder = new Recorder(page.cdpClient);
      await recorder.start();

      // Simulate a click via CDP
      await simulateClick(page, '#show-dynamic');

      // Stop and get output
      const output = await recorder.stop();

      // Verify we got a click step
      expect(output.steps.length).toBeGreaterThanOrEqual(1);

      const clickStep = output.steps.find((s) => s.action === 'click');
      expect(clickStep).toBeDefined();

      // Should have selector (either string or array)
      expect(clickStep?.selector).toBeDefined();
    });
  });

  test('should record input with value', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      // Start recording
      const recorder = new Recorder(page.cdpClient);
      await recorder.start();

      // Type into name field
      await page.fill('#name', 'Test User');

      // Small delay to ensure events are captured
      await sleep(100);

      // Stop and get output
      const output = await recorder.stop();

      // Verify we got a fill step
      const fillStep = output.steps.find((s) => s.action === 'fill');
      expect(fillStep).toBeDefined();
      expect(fillStep?.value).toBe('Test User');
    });
  });

  test('should redact password field values', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/login.html`);

      // Start recording
      const recorder = new Recorder(page.cdpClient);
      await recorder.start();

      // Type into password field
      await page.fill('#password', 'supersecret123');

      // Small delay to ensure events are captured
      await sleep(100);

      // Stop and get output
      const output = await recorder.stop();

      // Find fill step for password
      const passwordStep = output.steps.find(
        (s) => s.action === 'fill' && s.value === '[REDACTED]'
      );
      expect(passwordStep).toBeDefined();

      // Verify the actual password is NOT in the output
      const hasPlainPassword = output.steps.some((s) => s.value === 'supersecret123');
      expect(hasPlainPassword).toBe(false);
    });
  });

  test('should generate multi-selector arrays ordered by quality', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/login.html`);

      // Start recording
      const recorder = new Recorder(page.cdpClient);
      await recorder.start();

      // Click on element with data-testid (stable attr)
      await simulateClick(page, '[data-testid="submit"]');

      // Stop and get output
      const output = await recorder.stop();

      // Find the click step
      const clickStep = output.steps.find((s) => s.action === 'click');
      expect(clickStep).toBeDefined();

      // Selector should be an array (multiple candidates) or string
      const selector = clickStep?.selector;
      if (Array.isArray(selector)) {
        // First selector should be role-name (highest priority)
        // Order: role-name > text > aria-label > testid > stable-attr > id > css-path
        const firstSelector = selector[0];
        expect(firstSelector).toContain('role=button');
        // data-testid should also be present in the array
        const hasTestId = selector.some((s) => s.includes('data-testid'));
        expect(hasTestId).toBe(true);
      } else if (typeof selector === 'string') {
        // Single selector - could be role-name or stable-attr
        expect(selector).toBeTruthy();
      }
    });
  });

  test.skipIf(!!process.env['CI'])('should record navigation via goto steps', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      // Start recording
      const recorder = new Recorder(page.cdpClient);
      await recorder.start();

      // Navigate to form page
      await page.goto(`${baseUrl}/form.html`);

      // Wait for recorder script to be injected on new page instead of
      // relying on a fixed sleep that races with faster navigation.
      await waitUntil(
        async () =>
          (await page.evaluate(
            () => (window as { __recorderInstalled?: boolean }).__recorderInstalled
          )) === true,
        {
          timeout: 2000,
          interval: 50,
          message: 'Recorder script was not injected after navigation',
        }
      );

      // Click something on the new page
      await simulateClick(page, '#name');

      // Wait until the post-navigation interaction is actually captured.
      // The goto step is synthesized from the first event on the new URL.
      await waitUntil(
        async () => recorder.getEvents().some((event) => event.url.includes('/form.html')),
        {
          timeout: 2000,
          interval: 50,
          message: 'Recorder did not capture an event on the navigated page',
        }
      );

      // Stop and get output
      const output = await recorder.stop();

      // Should have a goto step for the navigation
      const gotoStep = output.steps.find((s) => s.action === 'goto');
      expect(gotoStep).toBeDefined();
      expect(gotoStep?.url).toContain('form.html');
    });
  });

  test('should handle empty recording', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/basic.html`);

      // Start recording
      const recorder = new Recorder(page.cdpClient);
      await recorder.start();

      // Don't do anything, just stop immediately
      const output = await recorder.stop();

      // Output should be valid with empty steps
      expect(output.recordedAt).toBeDefined();
      expect(output.startUrl).toContain('basic.html');
      expect(output.duration).toBeGreaterThanOrEqual(0);
      expect(output.steps).toEqual([]);
    });
  });
});

/**
 * Simulate a real click via CDP Input events
 */
async function simulateClick(
  page: { cdpClient: { send: (m: string, p?: Record<string, unknown>) => Promise<unknown> } },
  selector: string
): Promise<void> {
  // Get element position via evaluate
  const cdp = page.cdpClient;

  const result = (await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`,
    returnByValue: true,
  })) as { result: { value: { x: number; y: number } | null } };

  const pos = result.result.value;
  if (!pos) throw new Error(`Element not found: ${selector}`);

  // Dispatch mouse events
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: pos.x,
    y: pos.y,
    button: 'left',
    clickCount: 1,
  });

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: pos.x,
    y: pos.y,
    button: 'left',
    clickCount: 1,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
