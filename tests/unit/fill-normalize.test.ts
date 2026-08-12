import { describe, expect, it } from 'bun:test';
import { fillValuesMatchNormalized, normalizeFillValue } from '../../src/browser/fill-normalize.ts';

describe('normalizeFillValue', () => {
  it('collapses runs of unicode whitespace to a single space', () => {
    expect(normalizeFillValue('4111  1111\t1111  1111')).toBe('4111 1111 1111 1111');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeFillValue('  hello world  ')).toBe('hello world');
  });

  it('treats NBSP as whitespace', () => {
    expect(normalizeFillValue('44\u00a07881\u00a0122333')).toBe('44 7881 122333');
  });

  it('applies NFKC normalization', () => {
    // Fullwidth digits/letters collapse to their ASCII form under NFKC.
    expect(normalizeFillValue('\uFF21\uFF22\uFF23')).toBe('ABC');
  });

  it('is a no-op for already-normalized strings', () => {
    expect(normalizeFillValue('hello@example.com')).toBe('hello@example.com');
  });
});

describe('fillValuesMatchNormalized', () => {
  it('matches identical strings', () => {
    expect(fillValuesMatchNormalized('John Doe', 'John Doe')).toBe(true);
  });

  it('matches phone auto-formatting that inserts spaces', () => {
    expect(fillValuesMatchNormalized('+447881122333', '+44 7881 122333')).toBe(true);
  });

  it('matches credit card auto-formatting that inserts spaces', () => {
    expect(fillValuesMatchNormalized('4111111111111111', '4111 1111 1111 1111')).toBe(true);
  });

  it('matches when the formatter uses NBSP instead of a regular space', () => {
    expect(
      fillValuesMatchNormalized('4111 1111 1111 1111', '4111\u00a01111\u00a01111\u00a01111')
    ).toBe(true);
  });

  it('matches when whitespace already present in expected collapses the same way', () => {
    expect(fillValuesMatchNormalized('4111  1111', '4111 1111')).toBe(true);
  });

  it('is case-sensitive', () => {
    expect(fillValuesMatchNormalized('John Doe', 'john doe')).toBe(false);
  });

  it('does not strip punctuation', () => {
    expect(fillValuesMatchNormalized('4111-1111-1111-1111', '4111 1111 1111 1111')).toBe(false);
  });

  it('rejects genuinely different values', () => {
    expect(fillValuesMatchNormalized('John Doe', 'Jane Smith')).toBe(false);
  });

  it('rejects when actual has extra non-whitespace characters', () => {
    expect(fillValuesMatchNormalized('John', 'Johnny')).toBe(false);
  });
});
