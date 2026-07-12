/**
 * Unit tests for Page.elementState (mocked CDP, no Chrome).
 *
 * elementState runs a SINGLE Runtime.evaluate whose in-page script computes the
 * {exists, visible, count, text, boundingBox} shape and returns it by value.
 * With a real browser the script does the DOM work; here we mock CDP to route
 * on `method === 'Runtime.evaluate'`, inspect `params.expression`, and return a
 * canned result. The assertions verify that:
 *   - elementState issues exactly one Runtime.evaluate round-trip,
 *   - the expression is built correctly (selector embedded, shadow-piercing
 *     query + shared visibility predicate reused, returnByValue/awaitPromise),
 *   - the CDP result is faithfully surfaced as an ElementState, and
 *   - special selectors (text:/role:) are wired through the special-selector
 *     lookup instead of the CSS path.
 */

import { describe, expect, mock, test } from 'bun:test';
import { Page } from '../../src/browser/page.ts';
import type { ElementState } from '../../src/browser/types.ts';
import type { CDPClient } from '../../src/cdp/client.ts';

interface EvalCall {
  method: string;
  expression: string;
  params: Record<string, unknown>;
}

/**
 * Mock CDP that returns `canned` (the value the in-page script would compute)
 * as the by-value result of the elementState Runtime.evaluate. `value: undefined`
 * simulates an evaluate that produced no value. All other CDP methods resolve to
 * an empty object so Page construction/usage doesn't blow up.
 */
function createMockCDP(canned: ElementState | undefined) {
  const evalCalls: EvalCall[] = [];

  const cdp = {
    evalCalls,
    send: mock((method: string, params?: Record<string, unknown>) => {
      if (method === 'Runtime.evaluate') {
        const expression = (params?.['expression'] as string) ?? '';
        evalCalls.push({ method, expression, params: params ?? {} });
        return Promise.resolve({ result: { value: canned } });
      }
      return Promise.resolve({});
    }),
    on: mock(() => {}),
    off: mock(() => {}),
  };

  return cdp;
}

function makePage(cdp: ReturnType<typeof createMockCDP>): Page {
  return new Page(cdp as unknown as CDPClient, 'target-1');
}

describe('Page.elementState', () => {
  test('(a) present + visible element', async () => {
    const canned: ElementState = {
      exists: true,
      visible: true,
      count: 1,
      text: 'Toolbar',
      value: null,
      boundingBox: { x: 10, y: 20, width: 300, height: 40 },
    };
    const cdp = createMockCDP(canned);
    const page = makePage(cdp);

    const state = await page.elementState("[data-testid='toolbar']");

    expect(state).toEqual(canned);

    // Exactly one Runtime.evaluate round-trip
    expect(cdp.evalCalls.length).toBe(1);
    const call = cdp.evalCalls[0]!;
    // Selector is embedded, shadow-piercing query + shared visibility predicate reused
    expect(call.expression).toContain("[data-testid='toolbar']");
    expect(call.expression).toContain('deepQueryAll');
    expect(call.expression).toContain('bpElementVisible');
    expect(call.expression).toContain('getBoundingClientRect');
    // Single, self-contained evaluate contract
    expect(call.params['returnByValue']).toBe(true);
    expect(call.params['awaitPromise']).toBe(true);
    // No iframe context by default
    expect(call.params['contextId']).toBeUndefined();
  });

  test('(b) present but hidden element', async () => {
    const canned: ElementState = {
      exists: true,
      visible: false,
      count: 1,
      text: 'Hidden panel',
      value: null,
      boundingBox: null,
    };
    const cdp = createMockCDP(canned);
    const page = makePage(cdp);

    const state = await page.elementState('#dynamic');

    expect(state.exists).toBe(true);
    expect(state.visible).toBe(false);
    expect(state.count).toBe(1);
    expect(state.boundingBox).toBeNull();
  });

  test('(c) missing element', async () => {
    const canned: ElementState = {
      exists: false,
      visible: false,
      count: 0,
      text: '',
      value: null,
      boundingBox: null,
    };
    const cdp = createMockCDP(canned);
    const page = makePage(cdp);

    const state = await page.elementState('.does-not-exist');

    expect(state.exists).toBe(false);
    expect(state.count).toBe(0);
    expect(state.visible).toBe(false);
    expect(state.text).toBe('');
    expect(state.boundingBox).toBeNull();
  });

  test('(d) multiple matches', async () => {
    const canned: ElementState = {
      exists: true,
      visible: true,
      count: 3,
      text: 'First row',
      value: null,
      boundingBox: { x: 0, y: 0, width: 200, height: 24 },
    };
    const cdp = createMockCDP(canned);
    const page = makePage(cdp);

    const state = await page.elementState('.row');

    expect(state.exists).toBe(true);
    expect(state.count).toBe(3);
    expect(state.text).toBe('First row');
  });

  test('special selectors (text:) route through the special-selector lookup', async () => {
    const canned: ElementState = {
      exists: true,
      visible: true,
      count: 1,
      text: 'Submit',
      value: null,
      boundingBox: { x: 5, y: 5, width: 80, height: 30 },
    };
    const cdp = createMockCDP(canned);
    const page = makePage(cdp);

    const state = await page.elementState('text:Submit');

    expect(state).toEqual(canned);
    const call = cdp.evalCalls[0]!;
    // Special selector => special-selector script is inlined; NOT a raw CSS query
    expect(call.expression).toContain('bpFindByText');
    expect(call.expression).not.toContain("deepQueryAll('text:Submit')");
  });

  test('surfaces a form-control value for an <input>/<select>', async () => {
    const canned: ElementState = {
      exists: true,
      visible: true,
      count: 1,
      text: '',
      value: 'jane@example.com',
      boundingBox: { x: 0, y: 0, width: 220, height: 32 },
    };
    const cdp = createMockCDP(canned);
    const page = makePage(cdp);

    const state = await page.elementState("input[name='email']");

    expect(state.value).toBe('jane@example.com');
    // The evaluate script feature-detects the form-control value.
    const call = cdp.evalCalls[0]!;
    expect(call.expression).toContain('INPUT|SELECT|TEXTAREA');
    expect(call.expression).toContain("'value' in first");
  });

  test('value is null for a non-form element', async () => {
    const canned: ElementState = {
      exists: true,
      visible: true,
      count: 1,
      text: 'Toolbar',
      value: null,
      boundingBox: { x: 0, y: 0, width: 300, height: 40 },
    };
    const cdp = createMockCDP(canned);
    const page = makePage(cdp);

    const state = await page.elementState("[data-testid='toolbar']");

    expect(state.value).toBeNull();
    expect(state.text).toBe('Toolbar');
  });

  test('falls back to an empty state when evaluate yields no value', async () => {
    const cdp = createMockCDP(undefined);
    const page = makePage(cdp);

    const state = await page.elementState('#whatever');

    expect(state).toEqual({
      exists: false,
      visible: false,
      count: 0,
      text: '',
      value: null,
      boundingBox: null,
    });
  });
});
