/**
 * Safe submit — submit with verification and outcome classification
 */

import {
  captureStateSignature,
  evaluateOutcome,
  NetworkResponseTracker,
} from '../actions/conditions.ts';
import type { Condition, MatchedCondition, OutcomeStatus } from '../actions/types.ts';
import type { Page } from './page.ts';

export interface SubmitAndVerifyOptions {
  /** Form selector to submit */
  selector: string | string[];
  /** Submit method */
  method?: 'enter' | 'click' | 'enter+click';
  /** Conditions that indicate success (any match) */
  expectAny?: Condition[];
  /** Conditions that all must match for success */
  expectAll?: Condition[];
  /** Conditions that indicate failure */
  failIf?: Condition[];
  /** Whether this is a dangerous/irreversible action */
  dangerous?: boolean;
  /** Timeout for the entire operation */
  timeout?: number;
  /** Whether to wait for navigation after submit */
  waitForNavigation?: boolean | 'auto';
}

export interface SubmitAndVerifyResult {
  /** Whether submit was mechanically successful */
  submitted: boolean;
  /** Outcome classification */
  outcomeStatus: OutcomeStatus;
  /** Condition evaluation details */
  matchedConditions: MatchedCondition[];
  /** Whether safe to retry */
  retrySafe: boolean;
  /** Total time taken */
  durationMs: number;
  /** Error if submit failed mechanically */
  error?: string;
}

/**
 * Submit a form and verify the outcome using conditions.
 * Never auto-retries — returns the outcome for the caller to decide.
 */
export async function submitAndVerify(
  page: Page,
  options: SubmitAndVerifyOptions
): Promise<SubmitAndVerifyResult> {
  const {
    selector,
    method = 'enter+click',
    expectAny,
    expectAll,
    failIf,
    dangerous = false,
    timeout = 30000,
    waitForNavigation = 'auto',
  } = options;

  const startTime = Date.now();

  // Determine if we need network tracking or state signature
  const allConditions = [...(expectAny ?? []), ...(expectAll ?? []), ...(failIf ?? [])];
  const needsNetwork = allConditions.some((c) => c.kind === 'networkResponse');
  const needsSignature = allConditions.some((c) => c.kind === 'stateSignatureChanges');

  let networkTracker: NetworkResponseTracker | undefined;
  let beforeSignature: string | undefined;

  if (needsNetwork) {
    networkTracker = new NetworkResponseTracker();
    networkTracker.start(page.cdpClient);
  }
  if (needsSignature) {
    beforeSignature = await captureStateSignature(page);
  }

  try {
    // Perform the submit
    await page.submit(selector, {
      timeout,
      method,
      waitForNavigation,
    });

    // Stop network tracker
    if (networkTracker) networkTracker.stop(page.cdpClient);

    // If no conditions specified, just return success
    if (allConditions.length === 0) {
      return {
        submitted: true,
        outcomeStatus: 'success',
        matchedConditions: [],
        retrySafe: !dangerous,
        durationMs: Date.now() - startTime,
      };
    }

    // Evaluate outcome
    const outcome = await evaluateOutcome(page, {
      expectAny,
      expectAll,
      failIf,
      dangerous,
      networkTracker,
      beforeSignature,
    });

    return {
      submitted: true,
      outcomeStatus: outcome.outcomeStatus,
      matchedConditions: outcome.matchedConditions,
      retrySafe: outcome.retrySafe,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    if (networkTracker) networkTracker.stop(page.cdpClient);
    return {
      submitted: false,
      outcomeStatus: 'failed',
      matchedConditions: [],
      retrySafe: !dangerous,
      durationMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
