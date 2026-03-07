/**
 * Unit tests for assertion steps and retry support in batch executor
 */

import { describe, expect, test } from 'bun:test';
import { BatchExecutor } from '../../src/actions/executor.ts';
import type { Step } from '../../src/actions/types.ts';
import { validateSteps } from '../../src/actions/validate.ts';

/**
 * Create a mock page with controllable behavior for assertion testing.
 * Methods can be configured per-test via the returned helpers.
 */
function createMockPage(
  overrides: {
    waitForResult?: boolean;
    textResult?: string;
    urlResult?: string;
    evaluateResult?: unknown;
  } = {}
) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let waitForResult = overrides.waitForResult ?? true;
  let textResult = overrides.textResult ?? 'Hello World';
  let urlResult = overrides.urlResult ?? 'https://example.com/dashboard';
  let evaluateResult: unknown = overrides.evaluateResult ?? 'test-value';
  let lastMatchedSelector: string | undefined;
  let callCount = 0;
  // For retry tests: fail N times then succeed
  let failUntilAttempt = 0;

  const page = {
    calls,

    // --- Mock page methods used by assertion steps ---

    async waitFor(selector: string | string[], options?: unknown) {
      calls.push({ method: 'waitFor', args: [selector, options] });
      callCount++;
      if (callCount <= failUntilAttempt) return false;
      lastMatchedSelector = Array.isArray(selector) ? selector[0] : selector;
      return waitForResult;
    },

    async text(selector?: string) {
      calls.push({ method: 'text', args: [selector] });
      callCount++;
      if (callCount <= failUntilAttempt) throw new Error('text failed');
      return textResult;
    },

    async url() {
      calls.push({ method: 'url', args: [] });
      return urlResult;
    },

    async evaluate(expression: string) {
      calls.push({ method: 'evaluate', args: [expression] });
      return evaluateResult;
    },

    async goto(url: string, options?: unknown) {
      calls.push({ method: 'goto', args: [url, options] });
    },

    async click(selector: string | string[], options?: unknown) {
      calls.push({ method: 'click', args: [selector, options] });
      callCount++;
      if (callCount <= failUntilAttempt) throw new Error('Click failed');
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
        url: urlResult,
        title: 'Test',
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

    async switchToFrame(selector: string | string[], options?: unknown) {
      calls.push({ method: 'switchToFrame', args: [selector, options] });
    },

    async switchToMain() {
      calls.push({ method: 'switchToMain', args: [] });
    },

    getLastMatchedSelector() {
      return lastMatchedSelector;
    },

    // --- Test helpers ---

    setWaitForResult(value: boolean) {
      waitForResult = value;
    },

    setTextResult(value: string) {
      textResult = value;
    },

    setUrlResult(value: string) {
      urlResult = value;
    },

    setEvaluateResult(value: unknown) {
      evaluateResult = value;
    },

    /** Make the first N attempts fail (for retry testing) */
    failFirstN(n: number) {
      callCount = 0;
      failUntilAttempt = n;
    },

    resetCallCount() {
      callCount = 0;
    },

    reset() {
      calls.length = 0;
      callCount = 0;
      failUntilAttempt = 0;
      lastMatchedSelector = undefined;
    },
  };

  return page;
}

// Cast mock page to Page type for BatchExecutor
function createExecutor(page: ReturnType<typeof createMockPage>) {
  return new BatchExecutor(page as never);
}

describe('Assertion steps', () => {
  describe('assertVisible', () => {
    test('passes when element is visible', async () => {
      const page = createMockPage({ waitForResult: true });
      const executor = createExecutor(page);

      const result = await executor.execute([{ action: 'assertVisible', selector: '#banner' }]);

      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]!.success).toBe(true);
      // Should call waitFor with state: 'visible'
      const waitCall = page.calls.find((c) => c.method === 'waitFor');
      expect(waitCall).toBeDefined();
      expect(waitCall!.args[0]).toBe('#banner');
      expect(waitCall!.args[1]).toEqual(expect.objectContaining({ state: 'visible' }));
    });

    test('fails when element is not found', async () => {
      const page = createMockPage({ waitForResult: false });
      const executor = createExecutor(page);

      const result = await executor.execute([{ action: 'assertVisible', selector: '#missing' }]);

      expect(result.success).toBe(false);
      expect(result.steps[0]!.success).toBe(false);
      expect(result.steps[0]!.error).toContain('not visible');
    });
  });

  describe('assertExists', () => {
    test('passes when element is attached', async () => {
      const page = createMockPage({ waitForResult: true });
      const executor = createExecutor(page);

      const result = await executor.execute([{ action: 'assertExists', selector: '.widget' }]);

      expect(result.success).toBe(true);
      expect(result.steps[0]!.success).toBe(true);
      // Should call waitFor with state: 'attached'
      const waitCall = page.calls.find((c) => c.method === 'waitFor');
      expect(waitCall!.args[1]).toEqual(expect.objectContaining({ state: 'attached' }));
    });

    test('fails when element is not found', async () => {
      const page = createMockPage({ waitForResult: false });
      const executor = createExecutor(page);

      const result = await executor.execute([{ action: 'assertExists', selector: '#gone' }]);

      expect(result.success).toBe(false);
      expect(result.steps[0]!.success).toBe(false);
      expect(result.steps[0]!.error).toContain('does not exist');
    });
  });

  describe('assertText', () => {
    test('passes on substring match', async () => {
      const page = createMockPage({ textResult: 'Welcome to the dashboard' });
      const executor = createExecutor(page);

      const result = await executor.execute([{ action: 'assertText', expect: 'dashboard' }]);

      expect(result.success).toBe(true);
      expect(result.steps[0]!.success).toBe(true);
    });

    test('fails on mismatch', async () => {
      const page = createMockPage({ textResult: 'Welcome to the dashboard' });
      const executor = createExecutor(page);

      const result = await executor.execute([{ action: 'assertText', expect: 'settings page' }]);

      expect(result.success).toBe(false);
      expect(result.steps[0]!.success).toBe(false);
      expect(result.steps[0]!.error).toContain('text does not contain');
      expect(result.steps[0]!.error).toContain('settings page');
    });

    test('works with selector to scope text extraction', async () => {
      const page = createMockPage({ textResult: 'Scoped text content' });
      const executor = createExecutor(page);

      const result = await executor.execute([
        { action: 'assertText', selector: '#main', expect: 'Scoped text' },
      ]);

      expect(result.success).toBe(true);
      // Should have called text() with the selector
      const textCall = page.calls.find((c) => c.method === 'text');
      expect(textCall!.args[0]).toBe('#main');
    });

    test('works without selector (full page text)', async () => {
      const page = createMockPage({ textResult: 'Full page text' });
      const executor = createExecutor(page);

      const result = await executor.execute([{ action: 'assertText', expect: 'Full page' }]);

      expect(result.success).toBe(true);
      const textCall = page.calls.find((c) => c.method === 'text');
      expect(textCall!.args[0]).toBeUndefined();
    });

    test('accepts value field as alternative to expect', async () => {
      const page = createMockPage({ textResult: 'Hello World' });
      const executor = createExecutor(page);

      const result = await executor.execute([{ action: 'assertText', value: 'Hello' }]);

      expect(result.success).toBe(true);
    });
  });

  describe('assertUrl', () => {
    test('passes on URL substring match', async () => {
      const page = createMockPage({ urlResult: 'https://example.com/dashboard?tab=overview' });
      const executor = createExecutor(page);

      const result = await executor.execute([{ action: 'assertUrl', expect: 'dashboard' }]);

      expect(result.success).toBe(true);
      expect(result.steps[0]!.success).toBe(true);
    });

    test('fails on mismatch', async () => {
      const page = createMockPage({ urlResult: 'https://example.com/dashboard' });
      const executor = createExecutor(page);

      const result = await executor.execute([{ action: 'assertUrl', expect: '/settings' }]);

      expect(result.success).toBe(false);
      expect(result.steps[0]!.error).toContain('URL does not contain');
      expect(result.steps[0]!.error).toContain('/settings');
    });

    test('accepts url field as alternative to expect', async () => {
      const page = createMockPage({ urlResult: 'https://example.com/login' });
      const executor = createExecutor(page);

      const result = await executor.execute([{ action: 'assertUrl', url: '/login' }]);

      expect(result.success).toBe(true);
    });

    test('prefers expect over url when both provided', async () => {
      const page = createMockPage({ urlResult: 'https://example.com/dashboard' });
      const executor = createExecutor(page);

      // expect is checked first per the code: step.expect ?? step.url
      const result = await executor.execute([
        { action: 'assertUrl', expect: 'dashboard', url: 'https://wrong.com' } as Step,
      ]);

      expect(result.success).toBe(true);
    });
  });

  describe('assertValue', () => {
    test('passes on exact value match', async () => {
      const page = createMockPage({ waitForResult: true, evaluateResult: 'test@example.com' });
      const executor = createExecutor(page);

      const result = await executor.execute([
        { action: 'assertValue', selector: '#email', expect: 'test@example.com' },
      ]);

      expect(result.success).toBe(true);
      expect(result.steps[0]!.success).toBe(true);
    });

    test('fails on value mismatch', async () => {
      const page = createMockPage({ waitForResult: true, evaluateResult: 'wrong@email.com' });
      const executor = createExecutor(page);

      const result = await executor.execute([
        { action: 'assertValue', selector: '#email', expect: 'test@example.com' },
      ]);

      expect(result.success).toBe(false);
      expect(result.steps[0]!.error).toContain('Assertion failed');
      expect(result.steps[0]!.error).toContain('wrong@email.com');
      expect(result.steps[0]!.error).toContain('test@example.com');
    });

    test('fails when element not found', async () => {
      const page = createMockPage({ waitForResult: false });
      const executor = createExecutor(page);

      const result = await executor.execute([
        { action: 'assertValue', selector: '#missing', expect: 'anything' },
      ]);

      expect(result.success).toBe(false);
      expect(result.steps[0]!.error).toContain('not found');
    });

    test('accepts value field as alternative to expect', async () => {
      const page = createMockPage({ waitForResult: true, evaluateResult: 'hello' });
      const executor = createExecutor(page);

      const result = await executor.execute([
        { action: 'assertValue', selector: '#input', value: 'hello' },
      ]);

      expect(result.success).toBe(true);
    });
  });
});

describe('Retry support', () => {
  test('retries N times before final failure', async () => {
    const page = createMockPage({ waitForResult: false });
    const executor = createExecutor(page);

    const result = await executor.execute([
      { action: 'assertVisible', selector: '#el', retry: 2, retryDelay: 10 },
    ]);

    expect(result.success).toBe(false);
    // waitFor should be called 3 times total (1 initial + 2 retries)
    const waitCalls = page.calls.filter((c) => c.method === 'waitFor');
    expect(waitCalls).toHaveLength(3);
  });

  test('succeeds on retry after initial failure', async () => {
    const page = createMockPage({ waitForResult: false });
    const executor = createExecutor(page);

    // After 2 calls to waitFor (which return false and cause assertVisible to throw),
    // the 3rd call should succeed
    page.failFirstN(2);
    // Override waitFor to succeed after the fail count
    page.setWaitForResult(true);

    const result = await executor.execute([
      { action: 'assertVisible', selector: '#el', retry: 3, retryDelay: 10 },
    ]);

    // The first 2 attempts fail (waitFor returns false -> throw), 3rd succeeds (returns true)
    // failFirstN(2) makes waitFor return false for callCount <= 2
    expect(result.success).toBe(true);
    expect(result.steps[0]!.success).toBe(true);
  });

  test('retryDelay is respected', async () => {
    const page = createMockPage({ waitForResult: false });
    const executor = createExecutor(page);

    const retryDelay = 50;
    const start = Date.now();

    await executor.execute([{ action: 'assertVisible', selector: '#el', retry: 2, retryDelay }]);

    const elapsed = Date.now() - start;
    // 2 retries * 50ms = at least ~100ms of delay
    expect(elapsed).toBeGreaterThanOrEqual(80); // Allow slight timing variance
  });

  test('retry works with non-assertion actions (click)', async () => {
    const page = createMockPage();
    const executor = createExecutor(page);

    // Fail the first click attempt, succeed on the second
    page.failFirstN(1);

    const result = await executor.execute([
      { action: 'click', selector: '#btn', retry: 1, retryDelay: 10 },
    ]);

    expect(result.success).toBe(true);
    const clickCalls = page.calls.filter((c) => c.method === 'click');
    expect(clickCalls).toHaveLength(2);
  });

  test('default retryDelay is 500ms when not specified', async () => {
    const page = createMockPage({ waitForResult: false });
    const executor = createExecutor(page);

    const start = Date.now();

    await executor.execute([{ action: 'assertVisible', selector: '#el', retry: 1 }]);

    const elapsed = Date.now() - start;
    // 1 retry with default 500ms delay
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });

  test('no retry by default (retry: 0)', async () => {
    const page = createMockPage({ waitForResult: false });
    const executor = createExecutor(page);

    const result = await executor.execute([{ action: 'assertVisible', selector: '#el' }]);

    expect(result.success).toBe(false);
    const waitCalls = page.calls.filter((c) => c.method === 'waitFor');
    expect(waitCalls).toHaveLength(1);
  });
});

describe('Assertion validation', () => {
  test('assertText without expect or value fails validation', () => {
    const result = validateSteps([{ action: 'assertText', selector: '#el' }]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain('assertText requires "expect" or "value"');
  });

  test('assertText with expect passes validation', () => {
    const result = validateSteps([{ action: 'assertText', expect: 'hello' }]);
    expect(result.valid).toBe(true);
  });

  test('assertText with value passes validation', () => {
    const result = validateSteps([{ action: 'assertText', value: 'hello' }]);
    expect(result.valid).toBe(true);
  });

  test('assertUrl without expect or url fails validation', () => {
    const result = validateSteps([{ action: 'assertUrl' }]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain('assertUrl requires "expect" or "url"');
  });

  test('assertUrl with expect passes validation', () => {
    const result = validateSteps([{ action: 'assertUrl', expect: '/dashboard' }]);
    expect(result.valid).toBe(true);
  });

  test('assertUrl with url passes validation', () => {
    const result = validateSteps([{ action: 'assertUrl', url: '/dashboard' }]);
    expect(result.valid).toBe(true);
  });

  test('assertValue without expect or value fails validation', () => {
    const result = validateSteps([{ action: 'assertValue', selector: '#input' }]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain('assertValue requires "expect" or "value"');
  });

  test('assertValue with expect passes validation', () => {
    const result = validateSteps([{ action: 'assertValue', selector: '#input', expect: 'val' }]);
    expect(result.valid).toBe(true);
  });

  test('assertVisible requires selector', () => {
    const result = validateSteps([{ action: 'assertVisible' }]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('selector');
  });

  test('assertExists requires selector', () => {
    const result = validateSteps([{ action: 'assertExists' }]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('selector');
  });

  test('retry with wrong type fails validation', () => {
    const result = validateSteps([{ action: 'click', selector: '#btn', retry: 'yes' }]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain('"retry" expected number');
  });

  test('retryDelay with wrong type fails validation', () => {
    const result = validateSteps([{ action: 'click', selector: '#btn', retryDelay: true }]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain('"retryDelay" expected number');
  });

  test('retry with correct type passes validation', () => {
    const result = validateSteps([
      { action: 'click', selector: '#btn', retry: 3, retryDelay: 100 },
    ]);
    expect(result.valid).toBe(true);
  });

  test('assertion alias assert_visible suggests assertVisible', () => {
    const result = validateSteps([{ action: 'assert_visible', selector: '#el' }]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain('Did you mean "assertVisible"');
  });

  test('assertion alias assert_text suggests assertText', () => {
    const result = validateSteps([{ action: 'assert_text', expect: 'hi' }]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.message).toContain('Did you mean "assertText"');
  });
});
