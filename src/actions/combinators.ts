/**
 * Condition combinators for multi-path waits
 */

import type { Page } from '../browser/page.ts';
import { evaluateCondition, type NetworkResponseTracker } from './conditions.ts';
import type { Condition, MatchedCondition } from './types.ts';

export interface CombinatorResult {
  matched: boolean;
  matchedConditions: MatchedCondition[];
  /** Which path won (for race/any) */
  winnerIndex?: number;
}

/**
 * any() — succeeds if ANY condition matches
 */
export async function conditionAny(
  conditions: Condition[],
  page: Page,
  context?: { networkTracker?: NetworkResponseTracker; beforeSignature?: string }
): Promise<CombinatorResult> {
  const results: MatchedCondition[] = [];
  let winnerIndex: number | undefined;

  for (let i = 0; i < conditions.length; i++) {
    const result = await evaluateCondition(conditions[i]!, page, context);
    results.push(result);
    if (result.matched && winnerIndex === undefined) {
      winnerIndex = i;
    }
  }

  return {
    matched: winnerIndex !== undefined,
    matchedConditions: results,
    winnerIndex,
  };
}

/**
 * all() — succeeds only if ALL conditions match
 */
export async function conditionAll(
  conditions: Condition[],
  page: Page,
  context?: { networkTracker?: NetworkResponseTracker; beforeSignature?: string }
): Promise<CombinatorResult> {
  const results: MatchedCondition[] = [];
  let allMatched = true;

  for (const condition of conditions) {
    const result = await evaluateCondition(condition, page, context);
    results.push(result);
    if (!result.matched) allMatched = false;
  }

  return {
    matched: allMatched,
    matchedConditions: results,
  };
}

/**
 * not() — inverts a single condition
 */
export async function conditionNot(
  condition: Condition,
  page: Page,
  context?: { networkTracker?: NetworkResponseTracker; beforeSignature?: string }
): Promise<CombinatorResult> {
  const result = await evaluateCondition(condition, page, context);
  return {
    matched: !result.matched,
    matchedConditions: [
      {
        condition: result.condition,
        matched: !result.matched,
        detail: result.matched
          ? `NOT: condition was true (inverted to false): ${result.detail}`
          : `NOT: condition was false (inverted to true): ${result.detail}`,
      },
    ],
  };
}

/**
 * race() — evaluates conditions with polling until one matches or timeout.
 * Returns the first condition to match.
 */
export async function conditionRace(
  conditions: Condition[],
  page: Page,
  options: {
    timeout?: number;
    pollInterval?: number;
    networkTracker?: NetworkResponseTracker;
    beforeSignature?: string;
  } = {}
): Promise<CombinatorResult> {
  const { timeout = 10000, pollInterval = 200, networkTracker, beforeSignature } = options;
  const context = { networkTracker, beforeSignature };
  const startTime = Date.now();
  const deadline = startTime + timeout;

  // Immediate check
  const immediate = await conditionAny(conditions, page, context);
  if (immediate.matched) return immediate;

  // Polling loop
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    const result = await conditionAny(conditions, page, context);
    if (result.matched) return result;
  }

  // Timeout — return last evaluation
  return await conditionAny(conditions, page, context);
}
