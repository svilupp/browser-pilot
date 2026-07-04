import { describe, expect, it } from 'bun:test';
import {
  type CandidateStrategy,
  DEFAULT_TESTID_ATTRIBUTES,
  isDestructiveName,
  rankCandidates,
  rankSelectorCandidates,
} from '../../src/browser/selector-rank.ts';
import type { InteractiveElement, PageSnapshot } from '../../src/browser/types.ts';

/** Build a minimal browser-free PageSnapshot from interactive elements. */
function makeSnapshot(elements: InteractiveElement[]): PageSnapshot {
  return {
    url: 'https://example.test/',
    title: 'Test',
    timestamp: '2026-06-30T00:00:00.000Z',
    accessibilityTree: [],
    interactiveElements: elements,
    text: '',
  };
}

describe('rankSelectorCandidates', () => {
  it('yields a top testid candidate when data-testid attribute is present', () => {
    const el: InteractiveElement = {
      ref: 'e1',
      role: 'button',
      name: 'Save',
      selector: '[data-backend-node-id="1"]',
      attributes: { 'data-testid': 'save-btn' },
    };

    const candidates = rankSelectorCandidates(el);
    expect(candidates[0]?.strategy).toBe('testid');
    expect(candidates[0]?.selector).toBe('[data-testid="save-btn"]');
    // Highest score of the ladder.
    expect(candidates[0]?.score).toBeGreaterThanOrEqual(candidates[1]?.score ?? 0);
  });

  it('supports data-test and data-qa as testid sources', () => {
    const test: InteractiveElement = {
      ref: 'e1',
      role: 'button',
      name: 'A',
      selector: 'x',
      attributes: { 'data-test': 'a' },
    };
    const qa: InteractiveElement = {
      ref: 'e2',
      role: 'button',
      name: 'B',
      selector: 'x',
      attributes: { 'data-qa': 'b' },
    };

    expect(rankSelectorCandidates(test)[0]?.selector).toBe('[data-test="a"]');
    expect(rankSelectorCandidates(qa)[0]?.selector).toBe('[data-qa="b"]');
  });

  it('never yields testid or css when the element has no attributes', () => {
    const el: InteractiveElement = {
      ref: 'e2',
      role: 'button',
      name: 'Save',
      selector: '[data-backend-node-id="2"]',
    };

    const strategies = rankSelectorCandidates(el).map((c) => c.strategy);
    expect(strategies).not.toContain('testid');
    expect(strategies).not.toContain('css');
    // Honest accessibility-derived strategies remain.
    expect(strategies).toContain('role_name');
    expect(strategies).toContain('label');
    expect(strategies).toContain('scoped_text');
  });

  it('emits css from a stable id and skips dynamic/hashed ids', () => {
    const stable: InteractiveElement = {
      ref: 'e1',
      role: 'textbox',
      name: 'Email',
      selector: 'x',
      attributes: { id: 'email-input' },
    };
    const dynamic: InteractiveElement = {
      ref: 'e2',
      role: 'textbox',
      name: 'Email',
      selector: 'x',
      attributes: { id: 'a1b2c3d4e5f6' },
    };

    const stableCss = rankSelectorCandidates(stable).find((c) => c.strategy === 'css');
    expect(stableCss?.selector).toBe('#email-input');

    const dynamicCss = rankSelectorCandidates(dynamic).find((c) => c.strategy === 'css');
    expect(dynamicCss).toBeUndefined();
  });

  it('emits css from a stable class and skips emotion/styled hashes', () => {
    const el: InteractiveElement = {
      ref: 'e1',
      role: 'button',
      name: 'Save',
      selector: 'x',
      attributes: { class: 'css-1a2b3c primary-button' },
    };

    const css = rankSelectorCandidates(el).filter((c) => c.strategy === 'css');
    expect(css.length).toBe(1);
    expect(css[0]?.selector).toBe('.primary-button');
  });

  it('returns candidates sorted by score descending', () => {
    const el: InteractiveElement = {
      ref: 'e1',
      role: 'button',
      name: 'Save',
      selector: 'x',
      attributes: { 'data-testid': 'save', id: 'save-btn' },
    };

    const scores = rankSelectorCandidates(el).map((c) => c.score);
    const sorted = [...scores].sort((a, b) => b - a);
    expect(scores).toEqual(sorted);
  });
});

describe('rankCandidates', () => {
  it('ranks an ambiguous multi-Save snapshot best-match first', () => {
    const snapshot = makeSnapshot([
      { ref: 'e1', role: 'button', name: 'Save', selector: 'x' },
      {
        ref: 'e2',
        role: 'button',
        name: 'Save',
        selector: 'y',
        attributes: { 'data-testid': 'save-primary' },
      },
      { ref: 'e3', role: 'link', name: 'Save later', selector: 'z' },
    ]);

    const results = rankCandidates(snapshot, 'Save', { returnAll: true });
    expect(results.length).toBeGreaterThan(1);

    // The exact-name Save button backed by a testid should win.
    expect(results[0]?.ref).toBe('e2');
    expect(results[0]?.strategy).toBe('testid');

    // Scores are monotonically non-increasing.
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]?.score).toBeGreaterThanOrEqual(results[i]?.score ?? 0);
    }
  });

  it('returns one candidate per element by default (best-per-element)', () => {
    const snapshot = makeSnapshot([
      {
        ref: 'e1',
        role: 'button',
        name: 'Save',
        selector: 'x',
        attributes: { 'data-testid': 'save' },
      },
      { ref: 'e2', role: 'button', name: 'Cancel', selector: 'y' },
    ]);

    const results = rankCandidates(snapshot, 'Save');
    const refs = results.map((r) => r.ref);
    // At most one candidate per element.
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('honors opts.strategies as a filter', () => {
    const snapshot = makeSnapshot([
      {
        ref: 'e1',
        role: 'button',
        name: 'Save',
        selector: 'x',
        attributes: { 'data-testid': 'save' },
      },
    ]);

    const only: CandidateStrategy[] = ['role_name'];
    const results = rankCandidates(snapshot, 'Save', { strategies: only, returnAll: true });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.strategy === 'role_name')).toBe(true);
  });

  it('honors opts.minConfidence to drop weak candidates', () => {
    const snapshot = makeSnapshot([
      { ref: 'e1', role: 'button', name: 'Save', selector: 'x' },
      { ref: 'e2', role: 'button', name: 'Totally unrelated widget', selector: 'y' },
    ]);

    const all = rankCandidates(snapshot, 'Save');
    const filtered = rankCandidates(snapshot, 'Save', { minConfidence: 0.5 });

    expect(filtered.length).toBeLessThan(all.length);
    expect(filtered.every((r) => r.score >= 0.5)).toBe(true);
  });

  it('honors opts.maxResults to truncate', () => {
    const snapshot = makeSnapshot([
      { ref: 'e1', role: 'button', name: 'Save one', selector: 'x' },
      { ref: 'e2', role: 'button', name: 'Save two', selector: 'y' },
      { ref: 'e3', role: 'button', name: 'Save three', selector: 'z' },
    ]);

    const results = rankCandidates(snapshot, 'Save', { maxResults: 1 });
    expect(results.length).toBe(1);
  });

  it('biases toward textbox for fill and toward button for click', () => {
    const snapshot = makeSnapshot([
      { ref: 'e1', role: 'textbox', name: 'Email', selector: 'x' },
      { ref: 'e2', role: 'button', name: 'Email', selector: 'y' },
    ]);

    const fill = rankCandidates(snapshot, 'Email', { actionType: 'fill' });
    expect(fill[0]?.role).toBe('textbox');

    const click = rankCandidates(snapshot, 'Email', { actionType: 'click' });
    expect(click[0]?.role).toBe('button');
  });
});

describe('configurable testid attribute allowlist', () => {
  it('exposes the built-in default set', () => {
    expect([...DEFAULT_TESTID_ATTRIBUTES]).toEqual(['data-testid', 'data-test', 'data-qa']);
  });

  it('rankSelectorCandidates ignores non-default attrs when the option is omitted', () => {
    const el: InteractiveElement = {
      ref: 'e1',
      role: 'button',
      name: '',
      selector: 'x',
      attributes: { 'data-cmd': 'c2' },
    };
    // Default behavior: data-cmd is not a testid source, no testid candidate.
    expect(rankSelectorCandidates(el).some((c) => c.strategy === 'testid')).toBe(false);
  });

  it('rankSelectorCandidates emits [data-cmd="c2"] when data-cmd is in the allowlist', () => {
    const el: InteractiveElement = {
      ref: 'e1',
      role: 'button',
      name: '',
      selector: 'x',
      attributes: { 'data-cmd': 'c2' },
    };
    const candidates = rankSelectorCandidates(el, { testIdAttributes: ['data-cmd'] });
    const top = candidates[0];
    expect(top?.strategy).toBe('testid');
    expect(top?.selector).toBe('[data-cmd="c2"]');
  });

  it('keeps genuine data-testid priority over a custom attr', () => {
    const el: InteractiveElement = {
      ref: 'e1',
      role: 'button',
      name: 'Save',
      selector: 'x',
      attributes: { 'data-testid': 'save', 'data-cmd': 'c2' },
    };
    const testid = rankSelectorCandidates(el, { testIdAttributes: ['data-cmd'] }).find(
      (c) => c.strategy === 'testid'
    );
    expect(testid?.selector).toBe('[data-testid="save"]');
  });

  it('rankCandidates disambiguates 8 identical unnamed buttons via a unique data-cmd', () => {
    // Icon toolbar: 8 <button>s, no testid/label/text, aria-hidden SVG → empty
    // accessible name. Each has a unique data-cmd.
    const snapshot = makeSnapshot(
      Array.from({ length: 8 }, (_, i) => ({
        ref: `e${i + 1}`,
        role: 'button',
        name: '',
        selector: `[data-backend-node-id="${i + 1}"]`,
        attributes: { 'data-cmd': `c${i + 1}` },
      }))
    );

    // Without the option: nothing deterministic — no testid candidates at all.
    const baseline = rankCandidates(snapshot, 'c2', { returnAll: true });
    expect(baseline.some((c) => c.strategy === 'testid')).toBe(false);

    // With the option: each unique data-cmd becomes a high-confidence candidate.
    const results = rankCandidates(snapshot, 'c2', {
      returnAll: true,
      testIdAttributes: ['data-cmd'],
    });
    const forC2 = results.find((c) => c.ref === 'e2');
    expect(forC2).toBeDefined();
    const testidForC2 = results.find((c) => c.ref === 'e2' && c.selector === '[data-cmd="c2"]');
    expect(testidForC2?.strategy).toBe('testid');
  });

  it('does NOT emit a custom-attr candidate when its value is not unique', () => {
    // Two buttons share data-cmd="dup" → ambiguous → must not be emitted.
    const snapshot = makeSnapshot([
      { ref: 'e1', role: 'button', name: '', selector: 'x', attributes: { 'data-cmd': 'dup' } },
      { ref: 'e2', role: 'button', name: '', selector: 'y', attributes: { 'data-cmd': 'dup' } },
      { ref: 'e3', role: 'button', name: '', selector: 'z', attributes: { 'data-cmd': 'uniq' } },
    ]);

    const results = rankCandidates(snapshot, 'button', {
      returnAll: true,
      testIdAttributes: ['data-cmd'],
    });

    // The unique one is emitted...
    expect(results.some((c) => c.selector === '[data-cmd="uniq"]')).toBe(true);
    // ...the ambiguous shared value is never turned into a selector.
    expect(results.some((c) => c.selector === '[data-cmd="dup"]')).toBe(false);
  });

  it('default output is unchanged when testIdAttributes is omitted', () => {
    const snapshot = makeSnapshot([
      {
        ref: 'e1',
        role: 'button',
        name: 'Save',
        selector: 'x',
        attributes: { 'data-testid': 'save', 'data-cmd': 'c1' },
      },
    ]);

    const withOption = rankCandidates(snapshot, 'Save', {
      returnAll: true,
      testIdAttributes: [],
    });
    const withoutOption = rankCandidates(snapshot, 'Save', { returnAll: true });
    expect(withOption).toEqual(withoutOption);
    // data-cmd never leaks in when it isn't in the allowlist.
    expect(withoutOption.some((c) => c.selector.includes('data-cmd'))).toBe(false);
  });
});

describe('destructive-candidate tagging', () => {
  it('exports isDestructiveName matching generic destructive words (whole-word, case-insensitive)', () => {
    for (const name of [
      'Print',
      'Print order',
      'Delete',
      'Remove item',
      'Discard changes',
      'Archive',
      'Unsubscribe',
      'Cancel order',
      'Cancel subscription',
      'Deactivate account',
      'Destroy',
      'Reset password',
      'Revoke access',
      'Terminate',
    ]) {
      expect(isDestructiveName(name)).toBe(true);
    }
  });

  it('does not match substrings of unrelated words or benign labels', () => {
    for (const name of [
      'Sprint planning',
      'Fingerprint',
      'Save',
      'Continue',
      'Submit order',
      'Add to cart',
      '',
    ]) {
      expect(isDestructiveName(name)).toBe(false);
    }
    expect(isDestructiveName(undefined)).toBe(false);
  });

  it('tags matching ranked candidates as dangerous without dropping them', () => {
    const snapshot = makeSnapshot([
      { ref: 'e1', role: 'button', name: 'Print', selector: 'x', attributes: {} },
      { ref: 'e2', role: 'button', name: 'Save', selector: 'y', attributes: {} },
    ]);

    const ranked = rankCandidates(snapshot, 'button', { returnAll: true });
    const print = ranked.filter((c) => c.name === 'Print');
    const save = ranked.filter((c) => c.name === 'Save');

    // Tagged, not filtered.
    expect(print.length).toBeGreaterThan(0);
    expect(print.every((c) => c.dangerous === true)).toBe(true);
    // Benign candidate is not tagged (field omitted).
    expect(save.length).toBeGreaterThan(0);
    expect(save.every((c) => c.dangerous === undefined)).toBe(true);
  });
});
