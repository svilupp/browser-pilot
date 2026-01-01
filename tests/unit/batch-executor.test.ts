/**
 * Unit tests for batch executor
 */

import { describe, expect, test } from 'bun:test';
import type { BatchOptions, Step } from '../../src/actions/types.ts';

// Create a mock page for testing
function createMockPage() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const shouldFail = new Set<string>();

  const page = {
    calls,

    async goto(url: string, options?: unknown) {
      calls.push({ method: 'goto', args: [url, options] });
      if (shouldFail.has('goto')) throw new Error('Navigation failed');
    },

    async click(selector: string | string[], options?: unknown) {
      calls.push({ method: 'click', args: [selector, options] });
      if (shouldFail.has('click')) throw new Error('Click failed');
      return true;
    },

    async fill(selector: string | string[], value: string, options?: unknown) {
      calls.push({ method: 'fill', args: [selector, value, options] });
      if (shouldFail.has('fill')) throw new Error('Fill failed');
      return true;
    },

    async type(selector: string | string[], text: string, options?: unknown) {
      calls.push({ method: 'type', args: [selector, text, options] });
      if (shouldFail.has('type')) throw new Error('Type failed');
      return true;
    },

    async select(selectorOrConfig: unknown, valueOrOptions?: unknown, maybeOptions?: unknown) {
      calls.push({ method: 'select', args: [selectorOrConfig, valueOrOptions, maybeOptions] });
      if (shouldFail.has('select')) throw new Error('Select failed');
      return true;
    },

    async check(selector: string | string[], options?: unknown) {
      calls.push({ method: 'check', args: [selector, options] });
      if (shouldFail.has('check')) throw new Error('Check failed');
      return true;
    },

    async uncheck(selector: string | string[], options?: unknown) {
      calls.push({ method: 'uncheck', args: [selector, options] });
      if (shouldFail.has('uncheck')) throw new Error('Uncheck failed');
      return true;
    },

    async submit(selector: string | string[], options?: unknown) {
      calls.push({ method: 'submit', args: [selector, options] });
      if (shouldFail.has('submit')) throw new Error('Submit failed');
      return true;
    },

    async press(key: string) {
      calls.push({ method: 'press', args: [key] });
      if (shouldFail.has('press')) throw new Error('Press failed');
    },

    async focus(selector: string | string[], options?: unknown) {
      calls.push({ method: 'focus', args: [selector, options] });
      if (shouldFail.has('focus')) throw new Error('Focus failed');
      return true;
    },

    async hover(selector: string | string[], options?: unknown) {
      calls.push({ method: 'hover', args: [selector, options] });
      if (shouldFail.has('hover')) throw new Error('Hover failed');
      return true;
    },

    async scroll(selector: string | string[], options?: unknown) {
      calls.push({ method: 'scroll', args: [selector, options] });
      if (shouldFail.has('scroll')) throw new Error('Scroll failed');
      return true;
    },

    async waitFor(selector: string | string[], options?: unknown) {
      calls.push({ method: 'waitFor', args: [selector, options] });
      if (shouldFail.has('waitFor')) throw new Error('Wait failed');
      return true;
    },

    async waitForNavigation(options?: unknown) {
      calls.push({ method: 'waitForNavigation', args: [options] });
      if (shouldFail.has('waitForNavigation')) throw new Error('Navigation wait failed');
      return true;
    },

    async waitForNetworkIdle(options?: unknown) {
      calls.push({ method: 'waitForNetworkIdle', args: [options] });
      if (shouldFail.has('waitForNetworkIdle')) throw new Error('Network idle wait failed');
      return true;
    },

    async snapshot() {
      calls.push({ method: 'snapshot', args: [] });
      return {
        url: 'https://example.com',
        title: 'Example',
        timestamp: '',
        accessibilityTree: [],
        interactiveElements: [],
        text: '',
      };
    },

    async screenshot(options?: unknown) {
      calls.push({ method: 'screenshot', args: [options] });
      return 'base64data';
    },

    async evaluate(expression: string) {
      calls.push({ method: 'evaluate', args: [expression] });
      return { result: 'eval result' };
    },

    // Test helpers
    failOn(method: string) {
      shouldFail.add(method);
    },

    reset() {
      calls.length = 0;
      shouldFail.clear();
    },
  };

  return page;
}

// Simple executor implementation for testing
async function executeBatch(
  page: ReturnType<typeof createMockPage>,
  steps: Step[],
  options: BatchOptions = {}
) {
  const { timeout = 30000, onFail = 'stop' } = options;
  const results: Array<{
    index: number;
    action: string;
    success: boolean;
    durationMs: number;
    error?: string;
  }> = [];
  const startTime = Date.now();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const stepStart = Date.now();

    try {
      switch (step.action) {
        case 'goto':
          await page.goto(step.url!, { timeout: step.timeout ?? timeout, optional: step.optional });
          break;
        case 'click':
          await page.click(step.selector!, {
            timeout: step.timeout ?? timeout,
            optional: step.optional,
          });
          break;
        case 'fill':
          await page.fill(step.selector!, step.value as string, {
            timeout: step.timeout ?? timeout,
            optional: step.optional,
            clear: step.clear,
          });
          break;
        case 'type':
          await page.type(step.selector!, step.value as string, {
            timeout: step.timeout ?? timeout,
            optional: step.optional,
            delay: step.delay,
          });
          break;
        case 'select':
          await page.select(step.selector!, step.value!, {
            timeout: step.timeout ?? timeout,
            optional: step.optional,
          });
          break;
        case 'check':
          await page.check(step.selector!, {
            timeout: step.timeout ?? timeout,
            optional: step.optional,
          });
          break;
        case 'uncheck':
          await page.uncheck(step.selector!, {
            timeout: step.timeout ?? timeout,
            optional: step.optional,
          });
          break;
        case 'submit':
          await page.submit(step.selector!, {
            timeout: step.timeout ?? timeout,
            optional: step.optional,
            method: step.method,
          });
          break;
        case 'press':
          await page.press(step.key!);
          break;
        case 'wait':
          if (step.waitFor === 'navigation') {
            await page.waitForNavigation({
              timeout: step.timeout ?? timeout,
              optional: step.optional,
            });
          } else if (step.waitFor === 'networkIdle') {
            await page.waitForNetworkIdle({
              timeout: step.timeout ?? timeout,
              optional: step.optional,
            });
          } else {
            await page.waitFor(step.selector!, {
              timeout: step.timeout ?? timeout,
              optional: step.optional,
              state: step.waitFor,
            });
          }
          break;
        case 'snapshot':
          await page.snapshot();
          break;
        case 'screenshot':
          await page.screenshot({
            format: step.format,
            quality: step.quality,
            fullPage: step.fullPage,
          });
          break;
        case 'evaluate':
          await page.evaluate(step.value as string);
          break;
      }

      results.push({
        index: i,
        action: step.action,
        success: true,
        durationMs: Date.now() - stepStart,
      });
    } catch (error) {
      results.push({
        index: i,
        action: step.action,
        success: false,
        durationMs: Date.now() - stepStart,
        error: error instanceof Error ? error.message : String(error),
      });

      if (onFail === 'stop' && !step.optional) {
        return {
          success: false,
          stoppedAtIndex: i,
          steps: results,
          totalDurationMs: Date.now() - startTime,
        };
      }
    }
  }

  return {
    success: results.every((r) => r.success || steps[r.index]?.optional),
    steps: results,
    totalDurationMs: Date.now() - startTime,
  };
}

describe('BatchExecutor', () => {
  test('should execute steps in order', async () => {
    const page = createMockPage();

    const result = await executeBatch(page, [
      { action: 'goto', url: 'https://example.com' },
      { action: 'click', selector: '#button' },
      { action: 'fill', selector: '#input', value: 'hello' },
    ]);

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(page.calls[0]).toEqual({
      method: 'goto',
      args: ['https://example.com', expect.any(Object)],
    });
    expect(page.calls[1]).toEqual({ method: 'click', args: ['#button', expect.any(Object)] });
    expect(page.calls[2]).toEqual({
      method: 'fill',
      args: ['#input', 'hello', expect.any(Object)],
    });
  });

  test('should stop on failure with onFail: stop', async () => {
    const page = createMockPage();
    page.failOn('click');

    const result = await executeBatch(
      page,
      [
        { action: 'goto', url: 'https://example.com' },
        { action: 'click', selector: '#button' },
        { action: 'fill', selector: '#input', value: 'hello' },
      ],
      { onFail: 'stop' }
    );

    expect(result.success).toBe(false);
    expect(result.stoppedAtIndex).toBe(1);
    expect(result.steps).toHaveLength(2);
    expect(page.calls).toHaveLength(2); // goto and click, no fill
  });

  test('should continue on failure with onFail: continue', async () => {
    const page = createMockPage();
    page.failOn('click');

    const result = await executeBatch(
      page,
      [
        { action: 'goto', url: 'https://example.com' },
        { action: 'click', selector: '#button' },
        { action: 'fill', selector: '#input', value: 'hello' },
      ],
      { onFail: 'continue' }
    );

    expect(result.success).toBe(false);
    expect(result.stoppedAtIndex).toBeUndefined();
    expect(result.steps).toHaveLength(3);
    expect(page.calls).toHaveLength(3);
  });

  test('should not stop on optional step failure', async () => {
    const page = createMockPage();
    page.failOn('click');

    const result = await executeBatch(
      page,
      [
        { action: 'goto', url: 'https://example.com' },
        { action: 'click', selector: '#button', optional: true },
        { action: 'fill', selector: '#input', value: 'hello' },
      ],
      { onFail: 'stop' }
    );

    expect(result.success).toBe(true); // Optional failures don't affect overall success
    expect(result.stoppedAtIndex).toBeUndefined();
    expect(result.steps).toHaveLength(3);
    expect(page.calls).toHaveLength(3);
  });

  test('should track step timing', async () => {
    const page = createMockPage();

    const result = await executeBatch(page, [{ action: 'goto', url: 'https://example.com' }]);

    expect(result.steps[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  test('should support multi-selector', async () => {
    const page = createMockPage();

    await executeBatch(page, [
      { action: 'click', selector: ['#primary', '.fallback', '[data-button]'] },
    ]);

    expect(page.calls[0]).toEqual({
      method: 'click',
      args: [['#primary', '.fallback', '[data-button]'], expect.any(Object)],
    });
  });

  test('should handle all action types', async () => {
    const page = createMockPage();

    const steps: Step[] = [
      { action: 'goto', url: 'https://example.com' },
      { action: 'click', selector: '#btn' },
      { action: 'fill', selector: '#input', value: 'text' },
      { action: 'type', selector: '#search', value: 'query' },
      { action: 'select', selector: '#dropdown', value: 'option1' },
      { action: 'check', selector: '#checkbox' },
      { action: 'uncheck', selector: '#checkbox' },
      { action: 'submit', selector: '#form' },
      { action: 'press', key: 'Enter' },
      { action: 'wait', selector: '#loaded', waitFor: 'visible' },
      { action: 'wait', waitFor: 'navigation' },
      { action: 'wait', waitFor: 'networkIdle' },
      { action: 'snapshot' },
      { action: 'screenshot', format: 'png' },
      { action: 'evaluate', value: 'document.title' },
    ];

    const result = await executeBatch(page, steps);

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(steps.length);
    expect(page.calls).toHaveLength(steps.length);
  });
});
