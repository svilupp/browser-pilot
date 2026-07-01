import { describe, expect, it } from 'bun:test';
import {
  type CandidateStrategy,
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
