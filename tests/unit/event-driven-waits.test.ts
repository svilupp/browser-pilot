/**
 * Unit tests for event-driven wait edge cases NOT covered by wait-fastfail.test.ts.
 *
 * Covers:
 * - Exhaustive switch: invalid state throws
 * - isPageStatic error handling (CDP error -> treated as dynamic)
 * - attached state fast-fail on static page
 * - contextId forwarding to CDP calls
 * - Element found on final check after isPageStatic (second checkCondition in fast-fail block)
 * - waitForAnyElement timeout on dynamic page
 * - waitForAnyElement attached state fast-fail
 * - Default options (no options passed)
 */

import { describe, expect, mock, test } from 'bun:test';
import { waitForAnyElement, waitForElement } from '../../src/wait/strategies.ts';

/**
 * Create a mock CDP client.
 *
 * @param elementFound - whether element checks return true
 * @param pageStatic - whether isPageStatic returns true
 * @param options.throwOnStatic - if true, isPageStatic call throws (simulates CDP error)
 * @param options.elementFoundOnSecondCheck - element not found on first check, found after isPageStatic
 * @param options.contextIdCapture - array to capture contextId values passed to CDP
 */
function createMockCDP(
  elementFound: boolean,
  pageStatic: boolean,
  options: {
    throwOnStatic?: boolean;
    elementFoundOnSecondCheck?: boolean;
    contextIdCapture?: Array<number | undefined>;
  } = {}
) {
  let elementCheckCount = 0;
  const calls: Array<{ method: string; expression?: string; contextId?: number }> = [];

  const cdp = {
    calls,
    send: mock((method: string, params?: Record<string, unknown>) => {
      if (method === 'Runtime.evaluate') {
        const expression = (params?.['expression'] as string) ?? '';
        const contextId = params?.['contextId'] as number | undefined;
        calls.push({ method, expression: expression.slice(0, 80), contextId });

        if (options.contextIdCapture) {
          options.contextIdCapture.push(contextId);
        }

        // isPageStatic check
        if (expression.includes('MutationObserver')) {
          if (options.throwOnStatic) {
            return Promise.reject(new Error('CDP connection lost'));
          }
          return Promise.resolve({ result: { value: pageStatic } });
        }

        // Element check
        elementCheckCount++;
        if (options.elementFoundOnSecondCheck) {
          // First check: not found. After isPageStatic, second check: found.
          return Promise.resolve({ result: { value: elementCheckCount >= 2 } });
        }

        return Promise.resolve({ result: { value: elementFound } });
      }
      return Promise.resolve({});
    }),
    on: mock(() => {}),
    off: mock(() => {}),
  };

  return cdp;
}

describe('waitForElement edge cases', () => {
  test('throws on invalid state (exhaustive switch)', async () => {
    const cdp = createMockCDP(false, false);

    await expect(
      waitForElement(cdp as never, '#el', {
        state: 'invalid-state' as never,
        timeout: 300,
      })
    ).rejects.toThrow('Unhandled wait state');
  });

  test('isPageStatic CDP error treats page as dynamic (polls to timeout)', async () => {
    const cdp = createMockCDP(false, true, { throwOnStatic: true });

    const timeout = 400;
    const start = Date.now();
    const result = await waitForElement(cdp as never, '#missing', {
      timeout,
      pollInterval: 50,
    });
    const elapsed = Date.now() - start;

    // isPageStatic threw, so it falls through to polling loop
    expect(result.success).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(timeout - 50);
  });

  test('attached state fast-fails on static page when element missing', async () => {
    const cdp = createMockCDP(false, true); // not attached, page static

    const start = Date.now();
    const result = await waitForElement(cdp as never, '#missing', {
      state: 'attached',
      timeout: 5000,
      pollInterval: 100,
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    // attached is a presence wait, so fast-fail applies
    expect(elapsed).toBeLessThan(1000);
  });

  test('element found on second check after isPageStatic returns success', async () => {
    // Element not found on first immediate check, but found on second check
    // (the one inside the fast-fail block after isPageStatic)
    const cdp = createMockCDP(false, true, { elementFoundOnSecondCheck: true });

    const result = await waitForElement(cdp as never, '#appears', {
      timeout: 5000,
      pollInterval: 100,
    });

    expect(result.success).toBe(true);
    expect(result.waitedMs).toBeLessThan(1000);
  });

  test('contextId is forwarded to all CDP calls', async () => {
    const contextIds: Array<number | undefined> = [];
    const cdp = createMockCDP(true, false, { contextIdCapture: contextIds });

    await waitForElement(cdp as never, '#el', {
      timeout: 1000,
      contextId: 42,
    });

    // The element check should have received contextId 42
    expect(contextIds.length).toBeGreaterThan(0);
    expect(contextIds.every((id) => id === 42)).toBe(true);
  });

  test('defaults work when no options provided', async () => {
    const cdp = createMockCDP(true, false);

    const result = await waitForElement(cdp as never, '#el');

    expect(result.success).toBe(true);
    expect(result.waitedMs).toBeLessThan(200);
  });
});

describe('waitForAnyElement edge cases', () => {
  test('throws on invalid state (exhaustive switch)', async () => {
    const cdp = createMockCDP(false, false);

    await expect(
      waitForAnyElement(cdp as never, ['#a', '#b'], {
        state: 'invalid-state' as never,
        timeout: 300,
      })
    ).rejects.toThrow('Unhandled wait state');
  });

  test('attached state fast-fails on static page when no selector matches', async () => {
    const cdp = createMockCDP(false, true); // not attached, page static

    const start = Date.now();
    const result = await waitForAnyElement(cdp as never, ['#a', '#b', '#c'], {
      state: 'attached',
      timeout: 5000,
      pollInterval: 100,
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.selector).toBeUndefined();
    // attached is a presence wait, so fast-fail applies
    expect(elapsed).toBeLessThan(1000);
  });

  test('times out on dynamic page with no match', async () => {
    const cdp = createMockCDP(false, false);

    const timeout = 400;
    const start = Date.now();
    const result = await waitForAnyElement(cdp as never, ['#a', '#b'], {
      timeout,
      pollInterval: 50,
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.selector).toBeUndefined();
    expect(elapsed).toBeGreaterThanOrEqual(timeout - 50);
  });

  test('fast-fail skipped for detached state with multiple selectors', async () => {
    const cdp = createMockCDP(true, true); // elements attached, page static

    const timeout = 500;
    const start = Date.now();
    const result = await waitForAnyElement(cdp as never, ['#a', '#b'], {
      state: 'detached',
      timeout,
      pollInterval: 50,
    });
    const elapsed = Date.now() - start;

    // detached: !isAttached => !true = false, should poll to timeout
    expect(result.success).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(timeout - 50);
  });

  test('fast-fail skipped for short timeouts (< 300ms)', async () => {
    const cdp = createMockCDP(false, true); // page static, no elements

    const timeout = 200;
    const start = Date.now();
    const result = await waitForAnyElement(cdp as never, ['#a', '#b'], {
      timeout,
      pollInterval: 50,
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(timeout - 50);

    // Verify no isPageStatic call
    const mutationCalls = cdp.calls.filter((c) => c.expression?.includes('MutationObserver'));
    expect(mutationCalls.length).toBe(0);
  });

  test('contextId is forwarded in waitForAnyElement', async () => {
    const contextIds: Array<number | undefined> = [];
    const cdp = createMockCDP(true, false, { contextIdCapture: contextIds });

    await waitForAnyElement(cdp as never, ['#el'], {
      timeout: 1000,
      contextId: 99,
    });

    expect(contextIds.length).toBeGreaterThan(0);
    expect(contextIds.every((id) => id === 99)).toBe(true);
  });

  test('defaults work when no options provided', async () => {
    const cdp = createMockCDP(true, false);

    const result = await waitForAnyElement(cdp as never, ['#el']);

    expect(result.success).toBe(true);
    expect(result.selector).toBe('#el');
  });
});
