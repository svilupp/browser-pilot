/**
 * Centralized time access.
 *
 * All `Date.now()` / `new Date()` in library code should go through this
 * module so that ast-grep can enforce the boundary and tests can freeze time.
 */

/** Monotonic-ish millisecond timestamp (wraps `Date.now()`). */
export function now(): number {
  return Date.now();
}

/** Current time as an ISO-8601 string. */
export function isoNow(): string {
  return new Date().toISOString();
}
