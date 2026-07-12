import { describe, expect, test } from 'bun:test';
import {
  captureBeforeState,
  evaluateCondition,
  matchText,
  matchUrl,
} from '../../src/actions/conditions.ts';
import type { Condition } from '../../src/actions/types.ts';
import type { Page } from '../../src/browser/page.ts';

function pageFor(options: { url?: string; text?: string; field?: unknown }) {
  return {
    url: async () => options.url ?? 'https://example.test/orders/1?tab=timeline',
    text: async () => options.text ?? '',
    evaluate: async () => options.field,
    waitFor: async () => true,
    cdpClient: { send: async () => ({ targetInfos: [] }) },
  } as unknown as Page;
}

describe('exact assertion semantics', () => {
  test('does not let Unpaid satisfy exact Paid text', () => {
    expect(matchText('Unpaid', 'Paid', 'exact')).toBe(false);
    expect(matchText('Paid', 'Paid', 'exact')).toBe(true);
  });

  test('supports exact, normalized origin/path, glob, and contains URL modes', () => {
    expect(
      matchUrl('https://example.test/orders/1?tab=x', 'https://example.test/orders/1', 'exact')
    ).toBe(false);
    expect(
      matchUrl(
        'https://example.test/orders/1?tab=x',
        'https://example.test/orders/1',
        'origin_path'
      )
    ).toBe(true);
    expect(matchUrl('https://example.test/orders/1', 'https://example.test/orders/*', 'glob')).toBe(
      true
    );
    expect(matchUrl('https://example.test/orders/1', '/orders/1', 'contains')).toBe(true);
  });

  test('scopes text conditions to the requested selector', async () => {
    const condition: Condition = {
      kind: 'textAppears',
      selector: '#status-badge',
      text: 'Paid',
      mode: 'exact',
    };
    const result = await evaluateCondition(condition, pageFor({ text: 'Paid' }));
    expect(result.matched).toBe(true);
  });

  test('keeps the target selector when a landmark scope is also supplied', async () => {
    let expression = '';
    const page = pageFor({ text: 'Paid' });
    page.evaluate = (async (value: unknown) => {
      expression = String(value);
      return 'Paid';
    }) as Page['evaluate'];
    const result = await evaluateCondition(
      {
        kind: 'textAppears',
        selector: '#status-badge',
        landmark: 'main',
        text: 'Paid',
        mode: 'exact',
      },
      page
    );
    expect(result.matched).toBe(true);
    expect(expression).toContain('#status-badge');
  });

  test('captures URL and field transition state before the trigger', async () => {
    const page = pageFor({ field: { value: '10' } });
    const before = await captureBeforeState(page, [
      { kind: 'urlChanged' },
      { kind: 'fieldChanged', selector: '#bonus' },
    ]);
    expect(before.url).toContain('/orders/1');
    expect(before.targetIds).toEqual([]);
  });
});
