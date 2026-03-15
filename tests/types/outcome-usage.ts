/**
 * Compile-only type test for outcome-based execution types.
 * This file is never executed — it only verifies that the public API types
 * compose correctly at compile time.
 */

import type {
  Condition,
  MatchedCondition,
  OutcomeStatus,
  Step,
  StepResult,
} from '../../src/index.ts';

// --- Condition type discrimination ---

const urlCond: Condition = { kind: 'urlMatches', pattern: '**/dashboard*' };
const visCond: Condition = { kind: 'elementVisible', selector: '#toast' };
const hidCond: Condition = { kind: 'elementHidden', selector: ['.spinner', '.loading'] };
const textCond: Condition = { kind: 'textAppears', text: 'Success' };
const textSelCond: Condition = { kind: 'textAppears', selector: '#msg', text: 'Done' };
const changeCond: Condition = { kind: 'textChanges', to: 'Saved' };
const netCond: Condition = { kind: 'networkResponse', urlPattern: '**/api/save', status: 200 };
const stateCond: Condition = { kind: 'stateSignatureChanges' };

// --- Step with outcome fields ---

const stepWithOutcome: Step = {
  action: 'click',
  selector: '#save-btn',
  expectAny: [urlCond, visCond],
  expectAll: [hidCond, textCond],
  failIf: [{ kind: 'textAppears', text: 'Error' }],
  dangerous: true,
};

// --- Step without outcome (backward compatible) ---

const simpleStep: Step = {
  action: 'click',
  selector: '#btn',
};

// --- StepResult with outcome ---

const resultWithOutcome: StepResult = {
  index: 0,
  action: 'click',
  success: true,
  durationMs: 100,
  outcomeStatus: 'success',
  matchedConditions: [
    { condition: visCond, matched: true, detail: 'Element visible' },
    { condition: hidCond, matched: true },
  ],
  retrySafe: true,
};

// --- OutcomeStatus exhaustiveness ---

function handleOutcome(status: OutcomeStatus): string {
  switch (status) {
    case 'success':
      return 'ok';
    case 'failed':
      return 'fail';
    case 'ambiguous':
      return 'maybe';
    case 'unsafe_to_retry':
      return 'stop';
  }
}

// --- Multi-selector conditions ---

const multiSelCond: Condition = { kind: 'elementVisible', selector: ['#a', '#b', '#c'] };

// --- MatchedCondition used directly ---

const matched: MatchedCondition = { condition: visCond, matched: true, detail: 'visible' };

// Suppress unused variable warnings
void urlCond;
void visCond;
void hidCond;
void textCond;
void textSelCond;
void changeCond;
void netCond;
void stateCond;
void stepWithOutcome;
void simpleStep;
void resultWithOutcome;
void handleOutcome;
void multiSelCond;
void matched;
