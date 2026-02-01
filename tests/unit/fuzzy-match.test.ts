import { describe, expect, it } from 'bun:test';
import { fuzzyMatchElements, jaroWinkler, stringSimilarity } from '../../src/browser/fuzzy-match';
import type { InteractiveElement } from '../../src/browser/types';

describe('jaroWinkler', () => {
  it('returns 1.0 for identical strings', () => {
    expect(jaroWinkler('hello', 'hello')).toBe(1.0);
    expect(jaroWinkler('Submit', 'Submit')).toBe(1.0);
  });

  it('is case insensitive', () => {
    expect(jaroWinkler('Hello', 'hello')).toBe(1.0);
    expect(jaroWinkler('SUBMIT', 'submit')).toBe(1.0);
  });

  it('returns high score for hello vs hallo', () => {
    const score = jaroWinkler('hello', 'hallo');
    // Jaro-Winkler gives ~0.88 for these strings (4/5 chars match)
    expect(score).toBeGreaterThan(0.85);
    expect(score).toBeLessThan(0.96);
  });

  it('returns low score for completely different strings', () => {
    const score = jaroWinkler('abc', 'xyz');
    expect(score).toBeLessThan(0.5);
  });

  it('handles empty strings', () => {
    expect(jaroWinkler('', '')).toBe(0.0);
    expect(jaroWinkler('hello', '')).toBe(0.0);
    expect(jaroWinkler('', 'world')).toBe(0.0);
  });

  it('boosts score for common prefix', () => {
    const withPrefix = jaroWinkler('submit', 'submitting');
    const withoutPrefix = jaroWinkler('ubmit', 'bmitting');
    expect(withPrefix).toBeGreaterThan(withoutPrefix);
  });

  it('handles single character strings', () => {
    expect(jaroWinkler('a', 'a')).toBe(1.0);
    expect(jaroWinkler('a', 'b')).toBeLessThan(1.0);
  });
});

describe('stringSimilarity', () => {
  it('returns 1.0 for exact match', () => {
    expect(stringSimilarity('submit', 'submit')).toBe(1.0);
  });

  it('gives bonus when target contains query', () => {
    const containsScore = stringSimilarity('login', 'Login Button');
    const jwScore = jaroWinkler('login', 'Login Button');
    expect(containsScore).toBeGreaterThan(jwScore);
  });

  it('handles empty strings', () => {
    expect(stringSimilarity('', 'hello')).toBe(0.0);
    expect(stringSimilarity('hello', '')).toBe(0.0);
  });

  it('caps at 1.0', () => {
    const score = stringSimilarity('submit', 'Submit Form');
    expect(score).toBeLessThanOrEqual(1.0);
  });
});

describe('fuzzyMatchElements', () => {
  const testElements: InteractiveElement[] = [
    { ref: 'e1', role: 'button', name: 'Submit', selector: '#submit-btn', disabled: false },
    { ref: 'e2', role: 'button', name: 'Submit Form', selector: '#form-submit', disabled: false },
    { ref: 'e3', role: 'link', name: 'Login', selector: 'a.login', disabled: false },
    { ref: 'e4', role: 'link', name: 'Login Form', selector: 'a.login-form', disabled: false },
    { ref: 'e5', role: 'textbox', name: 'Email', selector: '#email', disabled: false },
    { ref: 'e6', role: 'button', name: 'Send', selector: '#send', disabled: false },
    { ref: 'e7', role: 'button', name: 'Cancel', selector: '#cancel', disabled: true },
  ];

  it('ranks exact name match highest for query "Submit"', () => {
    const results = fuzzyMatchElements('submit', testElements);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.element.name).toBe('Submit');
  });

  it('finds both Login button and Login Form link', () => {
    const results = fuzzyMatchElements('login', testElements);
    const names = results.map((r) => r.element.name);
    expect(names).toContain('Login');
    expect(names).toContain('Login Form');
  });

  it('returns results sorted by score descending', () => {
    const results = fuzzyMatchElements('submit', testElements);
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      const curr = results[i];
      if (prev && curr) {
        expect(prev.score).toBeGreaterThanOrEqual(curr.score);
      }
    }
  });

  it('includes matchReason explaining the match', () => {
    const results = fuzzyMatchElements('submit', testElements);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.matchReason).toBeTruthy();
    expect(typeof results[0]?.matchReason).toBe('string');
  });

  it('respects maxResults parameter', () => {
    const results = fuzzyMatchElements('button', testElements, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('returns empty array for empty query', () => {
    const results = fuzzyMatchElements('', testElements);
    expect(results).toEqual([]);
  });

  it('filters out low-score matches below threshold', () => {
    const results = fuzzyMatchElements('xyzabc123', testElements);
    // Should return empty or very few results for random query
    expect(results.length).toBeLessThan(3);
  });

  it('matches multi-word queries', () => {
    const results = fuzzyMatchElements('submit form', testElements);
    expect(results.length).toBeGreaterThan(0);
    // 'Submit Form' should rank high
    const topNames = results.slice(0, 2).map((r) => r.element.name);
    expect(topNames).toContain('Submit Form');
  });

  it('considers role in matching', () => {
    // Create elements where one has 'button' in the name
    const elements: InteractiveElement[] = [
      { ref: 'e1', role: 'button', name: 'Click Button', selector: '#btn', disabled: false },
      { ref: 'e2', role: 'link', name: 'Home', selector: 'a.home', disabled: false },
    ];
    const results = fuzzyMatchElements('button', elements);
    expect(results.length).toBeGreaterThan(0);
    // Should find the button element
    expect(results.some((r) => r.element.role === 'button')).toBe(true);
  });

  it('considers selector in matching', () => {
    const results = fuzzyMatchElements('email', testElements);
    expect(results.length).toBeGreaterThan(0);
    // Should find the email textbox via selector
    expect(results.some((r) => r.element.ref === 'e5')).toBe(true);
  });

  it('handles elements without names gracefully', () => {
    const elementsWithMissingName: InteractiveElement[] = [
      { ref: 'e1', role: 'button', name: '', selector: '#btn', disabled: false },
      { ref: 'e2', role: 'button', name: 'Submit', selector: '#submit', disabled: false },
    ];
    const results = fuzzyMatchElements('submit', elementsWithMissingName);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.element.name).toBe('Submit');
  });
});
