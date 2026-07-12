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

let executionSequence = 0;
let actionSequence = 0;

/** Allocate an ID that is unique across executions in this runtime. */
export function createExecutionId(prefix = 'execution'): string {
  executionSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${executionSequence.toString(36)}-${randomId()}`;
}

/** Allocate a globally unique action ID for one attempt. */
export function createActionId(executionId: string, stepIndex: number, attempt: number): string {
  actionSequence += 1;
  return `${executionId}-step-${stepIndex + 1}-attempt-${attempt + 1}-action-${actionSequence.toString(36)}-${randomId()}`;
}
