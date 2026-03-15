/**
 * Centralized random ID generation.
 *
 * All `Math.random()` in library code should go through this module so that
 * ast-grep can enforce the boundary and tests can inject seeded generators.
 */

/** Generate a short alphanumeric ID (8 chars, base-36). */
export function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
