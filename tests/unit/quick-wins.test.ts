/**
 * Unit tests for Phase 1 Quick Wins:
 * - Simple timeout wait
 * - Page-level scroll
 * - Ref-based selectors
 */

import { describe, expect, test } from 'bun:test';
import { BatchExecutor } from '../../src/actions/executor.ts';
import type { ActionType, Step } from '../../src/actions/types.ts';
import type { Page } from '../../src/browser/page.ts';

// Create a mock page for testing
function createMockPage() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const refMap = new Map<string, number>();
  let evaluateResult: unknown;

  const page = {
    calls,
    refMap,

    setEvaluateResult(result: unknown) {
      evaluateResult = result;
    },

    async goto(url: string, options?: unknown) {
      calls.push({ method: 'goto', args: [url, options] });
    },

    async click(selector: string | string[], options?: unknown) {
      calls.push({ method: 'click', args: [selector, options] });
      return true;
    },

    async fill(selector: string | string[], value: string, options?: unknown) {
      calls.push({ method: 'fill', args: [selector, value, options] });
      return true;
    },

    async type(selector: string | string[], text: string, options?: unknown) {
      calls.push({ method: 'type', args: [selector, text, options] });
      return true;
    },

    async select(selectorOrConfig: unknown, valueOrOptions?: unknown, maybeOptions?: unknown) {
      calls.push({ method: 'select', args: [selectorOrConfig, valueOrOptions, maybeOptions] });
      return true;
    },

    async check(selector: string | string[], options?: unknown) {
      calls.push({ method: 'check', args: [selector, options] });
      return true;
    },

    async uncheck(selector: string | string[], options?: unknown) {
      calls.push({ method: 'uncheck', args: [selector, options] });
      return true;
    },

    async submit(selector: string | string[], options?: unknown) {
      calls.push({ method: 'submit', args: [selector, options] });
      return true;
    },

    async press(key: string) {
      calls.push({ method: 'press', args: [key] });
    },

    async focus(selector: string | string[], options?: unknown) {
      calls.push({ method: 'focus', args: [selector, options] });
      return true;
    },

    async hover(selector: string | string[], options?: unknown) {
      calls.push({ method: 'hover', args: [selector, options] });
      return true;
    },

    async scroll(selector: string | string[], options?: unknown) {
      calls.push({ method: 'scroll', args: [selector, options] });
      return true;
    },

    async waitFor(selector: string | string[], options?: unknown) {
      calls.push({ method: 'waitFor', args: [selector, options] });
      return true;
    },

    async waitForNavigation(options?: unknown) {
      calls.push({ method: 'waitForNavigation', args: [options] });
      return true;
    },

    async waitForNetworkIdle(options?: unknown) {
      calls.push({ method: 'waitForNetworkIdle', args: [options] });
      return true;
    },

    async snapshot() {
      calls.push({ method: 'snapshot', args: [] });
      return {
        url: 'https://example.com',
        title: 'Example',
        timestamp: new Date().toISOString(),
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
      return evaluateResult ?? { result: 'eval result' };
    },

    async switchToFrame(selector: string | string[], options?: unknown) {
      calls.push({ method: 'switchToFrame', args: [selector, options] });
      return true;
    },

    async switchToMain() {
      calls.push({ method: 'switchToMain', args: [] });
    },

    reset() {
      calls.length = 0;
      refMap.clear();
      evaluateResult = undefined;
    },
  };

  return page;
}

describe('Simple Timeout Wait', () => {
  test('should execute simple timeout wait without selector', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);

    const startTime = Date.now();
    const result = await executor.execute([{ action: 'wait', timeout: 100 }]);
    const elapsed = Date.now() - startTime;

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.success).toBe(true);
    // Should have waited approximately 100ms
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(500);
    // Should NOT have called any page methods
    expect(page.calls).toHaveLength(0);
  });

  test('should use default 1000ms timeout when not specified', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);

    const startTime = Date.now();
    const result = await executor.execute([
      { action: 'wait' }, // No timeout, no selector, no waitFor
    ]);
    const elapsed = Date.now() - startTime;

    expect(result.success).toBe(true);
    // Should have waited approximately 1000ms (default)
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(1500);
  });

  test('should still support navigation wait', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);

    const result = await executor.execute([{ action: 'wait', waitFor: 'navigation' }]);

    expect(result.success).toBe(true);
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]?.method).toBe('waitForNavigation');
  });

  test('should still support networkIdle wait', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);

    const result = await executor.execute([{ action: 'wait', waitFor: 'networkIdle' }]);

    expect(result.success).toBe(true);
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]?.method).toBe('waitForNetworkIdle');
  });

  test('should still support selector wait', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);

    const result = await executor.execute([
      { action: 'wait', selector: '.loaded', waitFor: 'visible' },
    ]);

    expect(result.success).toBe(true);
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]?.method).toBe('waitFor');
    expect(page.calls[0]?.args[0]).toBe('.loaded');
  });
});

describe('Page-Level Scroll', () => {
  test('should execute page-level scroll with direction', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);

    const result = await executor.execute([{ action: 'scroll', direction: 'down', amount: 500 }]);

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]?.method).toBe('evaluate');
    expect(page.calls[0]?.args[0]).toBe('window.scrollBy(0, 500)');
  });

  test('should scroll up', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);

    await executor.execute([{ action: 'scroll', direction: 'up', amount: 300 }]);

    expect(page.calls[0]?.args[0]).toBe('window.scrollBy(0, -300)');
  });

  test('should scroll left', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);

    await executor.execute([{ action: 'scroll', direction: 'left', amount: 200 }]);

    expect(page.calls[0]?.args[0]).toBe('window.scrollBy(-200, 0)');
  });

  test('should scroll right', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);

    await executor.execute([{ action: 'scroll', direction: 'right', amount: 200 }]);

    expect(page.calls[0]?.args[0]).toBe('window.scrollBy(200, 0)');
  });

  test('should use default amount of 500px', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);

    await executor.execute([{ action: 'scroll', direction: 'down' }]);

    expect(page.calls[0]?.args[0]).toBe('window.scrollBy(0, 500)');
  });

  test('should use default direction of down', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);

    await executor.execute([{ action: 'scroll', amount: 1000 }]);

    expect(page.calls[0]?.args[0]).toBe('window.scrollBy(0, 1000)');
  });

  test('should still support scroll to element', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);

    await executor.execute([{ action: 'scroll', selector: '#footer' }]);

    expect(page.calls[0]?.method).toBe('scroll');
    expect(page.calls[0]?.args[0]).toBe('#footer');
  });

  test('should still support scroll to coordinates', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);

    await executor.execute([{ action: 'scroll', x: 0, y: 1000 }]);

    expect(page.calls[0]?.method).toBe('scroll');
    expect(page.calls[0]?.args).toEqual([
      'body',
      { x: 0, y: 1000, timeout: 30000, optional: false },
    ]);
  });
});

describe('Iframe Actions', () => {
  test('should execute switchFrame action', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);

    const result = await executor.execute([{ action: 'switchFrame', selector: 'iframe#checkout' }]);

    expect(result.success).toBe(true);
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]?.method).toBe('switchToFrame');
    expect(page.calls[0]?.args[0]).toBe('iframe#checkout');
  });

  test('should execute switchToMain action', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);

    const result = await executor.execute([{ action: 'switchToMain' }]);

    expect(result.success).toBe(true);
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]?.method).toBe('switchToMain');
  });

  test('should support iframe workflow', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);

    const result = await executor.execute([
      { action: 'switchFrame', selector: 'iframe#payment' },
      { action: 'fill', selector: '#card-number', value: '4242424242424242' },
      { action: 'switchToMain' },
      { action: 'click', selector: '#submit-order' },
    ]);

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(4);
    expect(page.calls[0]?.method).toBe('switchToFrame');
    expect(page.calls[1]?.method).toBe('fill');
    expect(page.calls[2]?.method).toBe('switchToMain');
    expect(page.calls[3]?.method).toBe('click');
  });

  test('should require selector for switchFrame', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);

    const result = await executor.execute([{ action: 'switchFrame' } satisfies Step]); // Missing selector

    expect(result.success).toBe(false);
    expect(result.steps[0]?.error).toContain('selector');
  });
});

describe('Error Messages', () => {
  test('should reference bp actions on unknown action', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);

    const result = await executor.execute([{ action: 'unknownAction' as ActionType }]);

    expect(result.success).toBe(false);
    expect(result.steps[0]?.error).toContain('bp actions');
  });
});
