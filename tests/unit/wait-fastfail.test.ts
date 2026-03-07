/**
 * Unit tests for waitForElement / waitForAnyElement fast-fail mechanism.
 *
 * The isPageStatic() function is internal — we test it indirectly through
 * waitForElement and waitForAnyElement by controlling what Runtime.evaluate returns.
 *
 * Detection strategy: isPageStatic sends a Runtime.evaluate whose expression
 * contains 'MutationObserver'. Element visibility/attachment checks do not.
 */

import { describe, expect, mock, test } from 'bun:test';
import { waitForAnyElement, waitForElement } from '../../src/wait/strategies.ts';

/**
 * Create a mock CDP client that routes Runtime.evaluate calls based on content.
 *
 * @param elementFound - whether element checks return true (visible/attached)
 * @param pageStatic - whether isPageStatic returns true
 * @param options.elementFoundAfterMs - if set, element becomes found after this delay
 */
function createMockCDP(
  elementFound: boolean,
  pageStatic: boolean,
  options: { elementFoundAfterMs?: number } = {}
) {
  const startTime = Date.now();
  const calls: Array<{ method: string; expression?: string }> = [];

  const cdp = {
    calls,
    send: mock((method: string, params?: Record<string, unknown>) => {
      if (method === 'Runtime.evaluate') {
        const expression = (params?.['expression'] as string) ?? '';
        calls.push({ method, expression: expression.slice(0, 80) });

        // isPageStatic check — expression contains MutationObserver
        if (expression.includes('MutationObserver')) {
          return Promise.resolve({ result: { value: pageStatic } });
        }

        // Element visibility/attachment check
        const elapsed = Date.now() - startTime;
        const found =
          options.elementFoundAfterMs !== undefined
            ? elapsed >= options.elementFoundAfterMs
            : elementFound;

        return Promise.resolve({ result: { value: found } });
      }
      return Promise.resolve({});
    }),
    on: mock(() => {}),
    off: mock(() => {}),
  };

  return cdp;
}

describe('waitForElement fast-fail', () => {
  test('fast-fails on static page when element not found', async () => {
    const cdp = createMockCDP(false, true); // element not found, page is static

    const start = Date.now();
    const result = await waitForElement(cdp as never, '#missing', {
      timeout: 5000,
      pollInterval: 100,
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    // Should return well before the 5s timeout — the isPageStatic observation
    // window is 200ms, so total should be under ~1s easily
    expect(elapsed).toBeLessThan(1000);
  });

  test('does not fast-fail on dynamic page — polls until timeout', async () => {
    const cdp = createMockCDP(false, false); // element not found, page is dynamic

    const timeout = 400;
    const start = Date.now();
    const result = await waitForElement(cdp as never, '#missing', {
      timeout,
      pollInterval: 50,
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    // Should have polled close to the full timeout
    expect(elapsed).toBeGreaterThanOrEqual(timeout - 50);
  });

  test('fast-fail skipped for short timeouts (< 300ms)', async () => {
    const cdp = createMockCDP(false, true); // page static, element not found

    const timeout = 200;
    const start = Date.now();
    const result = await waitForElement(cdp as never, '#missing', {
      timeout,
      pollInterval: 50,
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    // Should poll until timeout since fast-fail is skipped for timeout < 300
    expect(elapsed).toBeGreaterThanOrEqual(timeout - 50);

    // Verify no MutationObserver call was made (isPageStatic not called)
    const mutationCalls = cdp.calls.filter((c) => c.expression?.includes('MutationObserver'));
    expect(mutationCalls.length).toBe(0);
  });

  test('fast-fail skipped for hidden state', async () => {
    // Element IS visible (so hidden check fails), page is static
    const cdp = createMockCDP(true, true);

    const timeout = 500;
    const start = Date.now();
    const result = await waitForElement(cdp as never, '#element', {
      state: 'hidden',
      timeout,
      pollInterval: 50,
    });
    const elapsed = Date.now() - start;

    // hidden state: checkCondition = !isElementVisible => !true = false
    // fast-fail should NOT apply for hidden state, so it polls until timeout
    expect(result.success).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(timeout - 50);

    // No MutationObserver call
    const mutationCalls = cdp.calls.filter((c) => c.expression?.includes('MutationObserver'));
    expect(mutationCalls.length).toBe(0);
  });

  test('fast-fail skipped for detached state', async () => {
    // Element IS attached (so detached check fails), page is static
    const cdp = createMockCDP(true, true);

    const timeout = 500;
    const start = Date.now();
    const result = await waitForElement(cdp as never, '#element', {
      state: 'detached',
      timeout,
      pollInterval: 50,
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(timeout - 50);

    const mutationCalls = cdp.calls.filter((c) => c.expression?.includes('MutationObserver'));
    expect(mutationCalls.length).toBe(0);
  });

  test('returns immediately when element is already visible', async () => {
    const cdp = createMockCDP(true, false); // element found, page dynamic

    const start = Date.now();
    const result = await waitForElement(cdp as never, '#exists', {
      timeout: 5000,
      pollInterval: 100,
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    // Should return almost instantly (first check succeeds)
    expect(elapsed).toBeLessThan(200);

    // No MutationObserver call needed — immediate success
    const mutationCalls = cdp.calls.filter((c) => c.expression?.includes('MutationObserver'));
    expect(mutationCalls.length).toBe(0);
  });

  test('finds element during polling on dynamic page', async () => {
    // Element appears after 200ms on a dynamic page
    const cdp = createMockCDP(false, false, { elementFoundAfterMs: 200 });

    const result = await waitForElement(cdp as never, '#delayed', {
      timeout: 5000,
      pollInterval: 50,
    });

    expect(result.success).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(150); // at least some polling
    expect(result.waitedMs).toBeLessThan(1000); // but not too long
  });

  test('works with attached state', async () => {
    const cdp = createMockCDP(true, false);

    const result = await waitForElement(cdp as never, '#el', {
      state: 'attached',
      timeout: 1000,
    });

    expect(result.success).toBe(true);
  });
});

describe('waitForAnyElement', () => {
  test('returns first matching selector on immediate check', async () => {
    // Only the second selector will match
    let callCount = 0;
    const cdp = {
      send: mock((method: string, params?: Record<string, unknown>) => {
        if (method === 'Runtime.evaluate') {
          const expression = (params?.['expression'] as string) ?? '';
          if (expression.includes('MutationObserver')) {
            return Promise.resolve({ result: { value: false } });
          }
          callCount++;
          // First call = first selector (not found), second call = second selector (found)
          return Promise.resolve({ result: { value: callCount === 2 } });
        }
        return Promise.resolve({});
      }),
      on: mock(() => {}),
      off: mock(() => {}),
    };

    const result = await waitForAnyElement(cdp as never, ['#first', '#second', '#third'], {
      timeout: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.selector).toBe('#second');
  });

  test('fast-fails on static page when no selector matches', async () => {
    const cdp = createMockCDP(false, true);

    const start = Date.now();
    const result = await waitForAnyElement(cdp as never, ['#a', '#b', '#c'], {
      timeout: 5000,
      pollInterval: 100,
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.selector).toBeUndefined();
    expect(elapsed).toBeLessThan(1000);
  });

  test('polls until match on dynamic page', async () => {
    const cdp = createMockCDP(false, false, { elementFoundAfterMs: 250 });

    const result = await waitForAnyElement(cdp as never, ['#delayed'], {
      timeout: 5000,
      pollInterval: 50,
    });

    expect(result.success).toBe(true);
    expect(result.selector).toBe('#delayed');
    expect(result.waitedMs).toBeGreaterThanOrEqual(200);
  });

  test('fast-fail skipped for hidden state with multiple selectors', async () => {
    const cdp = createMockCDP(true, true); // elements visible, page static

    const timeout = 500;
    const start = Date.now();
    const result = await waitForAnyElement(cdp as never, ['#a', '#b'], {
      state: 'hidden',
      timeout,
      pollInterval: 50,
    });
    const elapsed = Date.now() - start;

    // hidden: !isVisible => !true = false, so no match, should poll to timeout
    expect(result.success).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(timeout - 50);
  });

  test('returns immediately when first selector matches', async () => {
    const cdp = createMockCDP(true, false);

    const start = Date.now();
    const result = await waitForAnyElement(cdp as never, ['#found', '#also'], {
      timeout: 5000,
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(result.selector).toBe('#found');
    expect(elapsed).toBeLessThan(200);
  });
});
