/**
 * Unit tests for Page.findElement candidate ORDER (mocked CDP, no Chrome).
 *
 * findElement receives an ordered preference list ("most-specific/explicit hint
 * first, fallbacks after"). It must make a SINGLE ordered pass and return the
 * first candidate that resolves — a `ref:` entry must NOT jump ahead of a
 * runtime selector that precedes it in the array (the historical bug), and a
 * stale/missing `ref:` must fall through to the next resolving candidate.
 *
 * We mock CDP by routing on `method`:
 *   - DOM.getDocument                     → a fixed root nodeId
 *   - Runtime.evaluate (visibility probe) → true iff the embedded selector is in
 *                                           the configured `visibleSelectors`
 *   - DOM.querySelector                   → the configured nodeId for a selector
 *   - DOM.describeNode                    → backendNodeId = nodeId + 10000
 *   - DOM.pushNodesByBackendIdsToFrontend → nodeId = backendId + 1000 (or empty
 *                                           for a configured "stale" backend id)
 * The mock records every backendNodeId it was asked to push, so a test can prove
 * a `ref:` was (or was NOT) attempted.
 */

import { describe, expect, mock, test } from 'bun:test';
import { Page } from '../../src/browser/page.ts';
import type { ElementInfo } from '../../src/browser/types.ts';
import type { CDPClient } from '../../src/cdp/client.ts';

interface MockConfig {
  /** CSS/attr selectors the instant visibility probe should report present. */
  visibleSelectors?: string[];
  /** selector → nodeId returned by DOM.querySelector. */
  cssNodeIds?: Record<string, number>;
  /** backendNodeIds whose push resolves empty (simulates a stale ref). */
  staleBackends?: number[];
}

function createMockCDP(config: MockConfig = {}) {
  const visibleSelectors = config.visibleSelectors ?? [];
  const cssNodeIds = config.cssNodeIds ?? {};
  const staleBackends = new Set(config.staleBackends ?? []);
  /** backendNodeIds the code attempted to resolve via a ref (in call order). */
  const pushedBackendIds: number[] = [];

  const cdp = {
    pushedBackendIds,
    send: mock((method: string, params?: Record<string, unknown>) => {
      switch (method) {
        case 'DOM.getDocument':
          return Promise.resolve({ root: { nodeId: 1 } });
        case 'DOM.pushNodesByBackendIdsToFrontend': {
          const ids = (params?.['backendNodeIds'] as number[]) ?? [];
          const backendId = ids[0];
          if (backendId !== undefined) pushedBackendIds.push(backendId);
          if (backendId === undefined || staleBackends.has(backendId)) {
            return Promise.resolve({ nodeIds: [] });
          }
          return Promise.resolve({ nodeIds: [backendId + 1000] });
        }
        case 'Runtime.evaluate': {
          const expression = (params?.['expression'] as string) ?? '';
          const visible = visibleSelectors.some((sel) => expression.includes(JSON.stringify(sel)));
          return Promise.resolve({ result: { value: visible } });
        }
        case 'DOM.querySelector': {
          const selector = (params?.['selector'] as string) ?? '';
          return Promise.resolve({ nodeId: cssNodeIds[selector] ?? 0 });
        }
        case 'DOM.describeNode': {
          const nodeId = (params?.['nodeId'] as number) ?? 0;
          return Promise.resolve({ node: { backendNodeId: nodeId + 10000 } });
        }
        default:
          return Promise.resolve({});
      }
    }),
    on: mock(() => {}),
    off: mock(() => {}),
  };

  return cdp;
}

function makePage(cdp: ReturnType<typeof createMockCDP>, refMap: Record<string, number>): Page {
  const page = new Page(cdp as unknown as CDPClient, 'target-1');
  page.importRefMap(refMap);
  return page;
}

/** findElement is private; exercise it directly through a typed cast. */
type FindElement = (
  selectors: string | string[],
  options?: { timeout?: number }
) => Promise<ElementInfo | null>;

function findElement(page: Page, selectors: string | string[]): Promise<ElementInfo | null> {
  return (page as unknown as { findElement: FindElement }).findElement(selectors);
}

describe('Page.findElement candidate order', () => {
  test('a runtime selector BEFORE a ref wins (the ref does not jump ahead)', async () => {
    // The exact shape from the bug report: a specific testid hint leads, a
    // competing ref for a same-named button follows.
    const cdp = createMockCDP({
      visibleSelectors: ["[data-testid='add-p-keyboard']"],
      cssNodeIds: { "[data-testid='add-p-keyboard']": 42 },
    });
    const page = makePage(cdp, { e11: 11 }); // ref:e11 IS valid, but comes second

    const el = await findElement(page, [
      "[data-testid='add-p-keyboard']",
      'ref:e11',
      "[data-testid='add-p-headphones']",
      'role:button:Add to cart',
    ]);

    expect(el).not.toBeNull();
    expect(el?.selector).toBe("[data-testid='add-p-keyboard']");
    expect(el?.nodeId).toBe(42);
    expect(el?.backendNodeId).toBe(10042);
    expect(page.getLastMatchedSelector()).toBe("[data-testid='add-p-keyboard']");
    // Critically: the ref was never even attempted — the leading hint won.
    expect(cdp.pushedBackendIds).toEqual([]);
  });

  test('a leading ref that IS valid still resolves via the ref (regression)', async () => {
    const cdp = createMockCDP({});
    const page = makePage(cdp, { e11: 11 });

    const el = await findElement(page, ['ref:e11', "[data-testid='x']"]);

    expect(el?.selector).toBe('ref:e11');
    expect(el?.nodeId).toBe(1011); // backendId(11) + 1000
    expect(el?.backendNodeId).toBe(11);
    expect(page.getLastMatchedSelector()).toBe('ref:e11');
    expect(cdp.pushedBackendIds).toEqual([11]);
  });

  test('a MISSING ref first falls through to a later resolving selector', async () => {
    const cdp = createMockCDP({
      visibleSelectors: ["[data-testid='keyboard']"],
      cssNodeIds: { "[data-testid='keyboard']": 50 },
    });
    const page = makePage(cdp, {}); // e99 is not in the ref map

    const el = await findElement(page, ['ref:e99', "[data-testid='keyboard']"]);

    expect(el?.selector).toBe("[data-testid='keyboard']");
    expect(el?.nodeId).toBe(50);
    expect(page.getLastMatchedSelector()).toBe("[data-testid='keyboard']");
    // Ref absent from the map → never pushed to the frontend.
    expect(cdp.pushedBackendIds).toEqual([]);
  });

  test('a STALE ref first (present but backend node gone) falls through', async () => {
    const cdp = createMockCDP({
      visibleSelectors: ["[data-testid='keyboard']"],
      cssNodeIds: { "[data-testid='keyboard']": 50 },
      staleBackends: [5], // push for backendNodeId 5 resolves empty
    });
    const page = makePage(cdp, { e5: 5 });

    const el = await findElement(page, ['ref:e5', "[data-testid='keyboard']"]);

    expect(el?.selector).toBe("[data-testid='keyboard']");
    expect(el?.nodeId).toBe(50);
    expect(page.getLastMatchedSelector()).toBe("[data-testid='keyboard']");
    // The stale ref WAS attempted, then fell through.
    expect(cdp.pushedBackendIds).toEqual([5]);
  });

  test('a not-yet-present runtime selector before a valid ref falls to the ref', async () => {
    // Preserves the old behavior for the "leading hint absent" case: when the
    // earlier runtime selector is not present, a following valid ref is used
    // rather than blocking — only a PRESENT earlier selector overrides the ref.
    const cdp = createMockCDP({ visibleSelectors: [] }); // nothing present
    const page = makePage(cdp, { e11: 11 });

    const el = await findElement(page, ['#not-present', 'ref:e11']);

    expect(el?.selector).toBe('ref:e11');
    expect(el?.nodeId).toBe(1011);
    expect(page.getLastMatchedSelector()).toBe('ref:e11');
    expect(cdp.pushedBackendIds).toEqual([11]);
  });

  test('order among runtime selectors is preserved (first present wins)', async () => {
    const cdp = createMockCDP({
      visibleSelectors: ['#a', '#b'],
      cssNodeIds: { '#a': 60, '#b': 61 },
    });
    const page = makePage(cdp, {});

    const el = await findElement(page, ['#a', '#b']);

    expect(el?.selector).toBe('#a');
    expect(el?.nodeId).toBe(60);
    expect(page.getLastMatchedSelector()).toBe('#a');
  });
});
