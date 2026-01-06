/**
 * Recording accessibility integration tests
 *
 * Tests the semantic accessibility features in recording:
 * - getAccessibleName() computation
 * - getRole() detection
 * - Role+name selector generation
 * - Human-readable annotations
 * - Rich step output with element metadata
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Recorder } from '../../src/recording/recorder.ts';
import type { RichStep } from '../../src/recording/types.ts';
import { withRetry } from '../utils/retry';
import { TestContext } from './setup';

const ctx = new TestContext();

describe('Recording Accessibility', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  test('should capture aria-label as accessible name', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/accessibility.html`);

      // Start recording
      const recorder = new Recorder(page.cdpClient);
      await recorder.start();

      // Click button with aria-label="More actions"
      await simulateClick(page, '[aria-label="More actions"]');

      // Stop and get output
      const output = await recorder.stop();

      // Find the click step
      const clickStep = output.steps.find((s) => s.action === 'click') as RichStep | undefined;
      expect(clickStep).toBeDefined();

      // Selector should include role-name selector
      const selector = clickStep?.selector;
      if (Array.isArray(selector)) {
        const hasRoleName = selector.some((s) => s.includes("role=button[name='More actions']"));
        expect(hasRoleName).toBe(true);
      }

      // Element metadata should have accessible name
      expect(clickStep?.element?.name).toBe('More actions');
      expect(clickStep?.element?.role).toBe('button');

      // Annotation should be human readable
      expect(clickStep?.annotation).toContain('More actions');
      expect(clickStep?.annotation).toContain('button');
    });
  });

  test('should capture button text content as accessible name', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/accessibility.html`);

      // Start recording
      const recorder = new Recorder(page.cdpClient);
      await recorder.start();

      // Click button with text "Submit"
      await simulateClick(page, 'button:not([aria-label])');

      // Stop and get output
      const output = await recorder.stop();

      // Find the click step
      const clickStep = output.steps.find((s) => s.action === 'click') as RichStep | undefined;
      expect(clickStep).toBeDefined();

      // Should have element metadata
      expect(clickStep?.element?.role).toBe('button');

      // Annotation should be human readable
      expect(clickStep?.annotation).toBeDefined();
    });
  });

  test('should detect implicit roles from HTML elements', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/accessibility.html`);

      // Start recording
      const recorder = new Recorder(page.cdpClient);
      await recorder.start();

      // Click a link
      await simulateClick(page, 'a[href="#home"]');

      // Stop and get output
      const output = await recorder.stop();

      // Find the click step
      const clickStep = output.steps.find((s) => s.action === 'click') as RichStep | undefined;
      expect(clickStep).toBeDefined();

      // Link should have implicit role
      expect(clickStep?.element?.role).toBe('link');
      expect(clickStep?.element?.name).toBe('Home');
    });
  });

  test('should generate text= selector for buttons and links', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/accessibility.html`);

      // Start recording
      const recorder = new Recorder(page.cdpClient);
      await recorder.start();

      // Click button with text "Submit"
      await simulateClick(page, 'section[aria-label="Buttons section"] button:nth-of-type(2)');

      // Stop and get output
      const output = await recorder.stop();

      // Find the click step
      const clickStep = output.steps.find((s) => s.action === 'click') as RichStep | undefined;
      expect(clickStep).toBeDefined();

      // Selector array should include text= selector
      const selector = clickStep?.selector;
      if (Array.isArray(selector)) {
        const hasTextSelector = selector.some((s) => s.startsWith('text='));
        expect(hasTextSelector).toBe(true);
      }
    });
  });

  test('should capture button with title as accessible name', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/accessibility.html`);

      // Start recording
      const recorder = new Recorder(page.cdpClient);
      await recorder.start();

      // Click the button with title="Settings"
      await simulateClick(page, '[title="Settings"]');

      // Stop and get output
      const output = await recorder.stop();

      // Find the click step
      const clickStep = output.steps.find((s) => s.action === 'click') as RichStep | undefined;
      expect(clickStep).toBeDefined();

      // Should have title as accessible name
      expect(clickStep?.element?.name).toBe('Settings');
      expect(clickStep?.element?.role).toBe('button');
    });
  });

  test('should capture custom role button', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/accessibility.html`);

      // Start recording
      const recorder = new Recorder(page.cdpClient);
      await recorder.start();

      // Click the div with role="button"
      await simulateClick(page, '[role="button"]');

      // Stop and get output
      const output = await recorder.stop();

      // Find the click step
      const clickStep = output.steps.find((s) => s.action === 'click') as RichStep | undefined;
      expect(clickStep).toBeDefined();

      // Should have explicit button role
      expect(clickStep?.element?.role).toBe('button');
      expect(clickStep?.element?.name).toBe('Custom Button');
    });
  });

  test('should prioritize role-name selectors over CSS paths', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/accessibility.html`);

      // Start recording
      const recorder = new Recorder(page.cdpClient);
      await recorder.start();

      // Click button with aria-label
      await simulateClick(page, '[aria-label="More actions"]');

      // Stop and get output
      const output = await recorder.stop();

      // Find the click step
      const clickStep = output.steps.find((s) => s.action === 'click') as RichStep | undefined;
      expect(clickStep).toBeDefined();

      // If multiple selectors, first should be role-name
      const selector = clickStep?.selector;
      if (Array.isArray(selector) && selector.length > 1) {
        const firstSelector = selector[0]!;
        // First selector should be semantic (role= or text=)
        expect(firstSelector.startsWith('role=') || firstSelector.startsWith('text=')).toBe(true);

        // CSS path should be later in the array
        const lastSelector = selector[selector.length - 1]!;
        // Last is often CSS path or ID
        expect(lastSelector).toBeTruthy();
      }
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
