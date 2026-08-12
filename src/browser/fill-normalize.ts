/**
 * Normalization helpers for fill verification.
 *
 * Auto-formatting inputs (phone masks, credit-card grouping, NBSP-inserting
 * formatters, etc.) rewrite the typed value as it's inserted, so an exact
 * `!==` comparison against the requested value spuriously fails even though
 * the field "took" the value correctly. `fillValuesMatchNormalized` lets fill
 * verification tolerate that class of formatting difference while remaining
 * case-sensitive and without stripping punctuation.
 */

/** NFKC-normalize + collapse all unicode whitespace to a single space + trim. Case-sensitive. */
export function normalizeFillValue(s: string): string {
  return s.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

/**
 * True if `expected` and `actual` match once whitespace differences are
 * normalized away (collapsed-whitespace equality), or once all whitespace is
 * stripped entirely (covers auto-spacing formatters that insert whitespace
 * the caller's value didn't have, e.g. "4111111111111111" -> "4111 1111 1111 1111").
 * Case-sensitive; does not strip punctuation.
 */
export function fillValuesMatchNormalized(expected: string, actual: string): boolean {
  const e = normalizeFillValue(expected);
  const a = normalizeFillValue(actual);
  return e === a || e.replace(/\s+/gu, '') === a.replace(/\s+/gu, '');
}
