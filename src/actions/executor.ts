/**
 * Batch action executor
 */

import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  getHighlightLabel,
  injectActionHighlight,
  removeActionHighlight,
  stepToHighlightKind,
} from '../browser/action-highlight.ts';
import { ActionabilityError } from '../browser/actionability.ts';
import { generateHints } from '../browser/hint-generator.ts';
import type { Page } from '../browser/page.ts';
import { captureStructureSignature } from '../browser/signature.ts';
import { classifyStaleError } from '../browser/stale-errors.ts';
import type { ActionReceipt } from '../browser/types.ts';
import { ElementNotFoundError, NavigationError, TimeoutError } from '../browser/types.ts';
import { CDPError } from '../cdp/protocol.ts';
import {
  canonicalizeRecordingArtifact,
  createRecordingManifest,
  type RecordingExecution,
  type RecordingFrame,
  validateRecordingManifest,
} from '../recording/manifest.ts';
import { redactValueForRecording } from '../recording/redaction.ts';
import { createActionId, createExecutionId } from '../runtime/id.ts';
import { type CanonicalTraceEvent, createTraceId, normalizeTraceEvent } from '../trace/model.ts';
import { TRACE_BINDING_NAME, TRACE_SCRIPT } from '../trace/script.ts';
import { formatConsoleArg, globToRegex, readString, readStringOr } from '../utils/strings.ts';
import {
  type AssertionBeforeState,
  captureBeforeState,
  captureStateSignature,
  evaluateOutcome,
  matchText,
  matchUrl,
  NetworkResponseTracker,
  type RetryDecision,
  readScopedElementState,
  readScopedText,
  shouldRetry,
} from './conditions.ts';
import type {
  ActionEffect,
  ActionType,
  BatchOptions,
  BatchResult,
  Condition,
  FailureReason,
  RecordOptions,
  Step,
  StepResult,
} from './types.ts';

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_RECORDING_SKIP_ACTIONS: ActionType[] = [
  'wait',
  'snapshot',
  'forms',
  'text',
  'screenshot',
];

interface RecordingContext {
  baseDir: string;
  screenshotDir: string;
  sessionId: string;
  frames: RecordingFrame[];
  traceEvents: CanonicalTraceEvent[];
  format: 'png' | 'jpeg' | 'webp';
  quality: number;
  highlights: boolean;
  skipActions: Set<ActionType>;
  executionId: string;
  executions: RecordingExecution[];
}

function loadExistingRecording(manifestPath: string): {
  frames: RecordingFrame[];
  traceEvents: CanonicalTraceEvent[];
  recordedAt?: string;
  startUrl?: string;
  executions?: RecordingExecution[];
} {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;

    if ((raw as { version?: number }).version === 1) {
      const legacy = raw as { frames?: RecordingFrame[]; recordedAt?: string; startUrl?: string };
      return {
        frames: Array.isArray(legacy.frames) ? legacy.frames : [],
        traceEvents: [],
        recordedAt: legacy.recordedAt,
        startUrl: legacy.startUrl,
      };
    }

    const artifact = canonicalizeRecordingArtifact(raw);
    const frames = artifact.actions.map<RecordingFrame>((action, index) => {
      // Match by position first. Legacy manifests reused action IDs, and a
      // Map(actionId) migration would silently collapse their evidence.
      const positional = artifact.screenshots[index];
      const screenshot =
        positional?.actionId === action.id
          ? positional
          : artifact.screenshots.find((candidate) => candidate.actionId === action.id);
      return {
        seq: index + 1,
        timestamp: Date.parse(action.ts),
        action: action.action,
        selector: action.selector,
        selectorUsed: action.selectorUsed,
        value: action.value,
        url: action.url,
        coordinates: action.coordinates,
        boundingBox: action.boundingBox,
        success: action.success,
        durationMs: action.durationMs,
        error: action.error,
        screenshot: screenshot?.file ?? '',
        pageUrl: action.pageUrl,
        pageTitle: action.pageTitle,
        stepIndex: action.stepIndex,
        actionId: action.id,
        executionId: action.executionId,
        attempt: action.attempt,
        dispatchState: action.dispatchState,
        retrySafe: action.retrySafe,
        targetId: action.targetId,
        effect: action.effect,
        anchor: action.anchor,
      };
    });

    return {
      frames,
      traceEvents: artifact.trace.events,
      recordedAt: artifact.recordedAt,
      startUrl: artifact.session.startUrl,
      executions: artifact.recipe.executions,
    };
  } catch {
    return { frames: [], traceEvents: [] };
  }
}

function classifyFailure(error: unknown): {
  reason: FailureReason;
  coveringElement?: { tag: string; id?: string; className?: string };
} {
  if (error instanceof ElementNotFoundError) {
    return { reason: 'missing' };
  }
  if (error instanceof ActionabilityError) {
    switch (error.failureType) {
      case 'visible':
        return { reason: 'hidden' };
      case 'hitTarget':
        return { reason: 'covered', coveringElement: error.coveringElement };
      case 'enabled':
        return { reason: 'disabled' };
      case 'editable':
        return { reason: error.message?.includes('readonly') ? 'readonly' : 'notEditable' };
      case 'stable':
        return { reason: 'replaced' };
      default:
        return { reason: 'unknown' };
    }
  }
  if (error instanceof TimeoutError) {
    return { reason: 'timeout' };
  }
  if (error instanceof NavigationError) {
    return { reason: 'navigation' };
  }
  if (error instanceof CDPError) {
    return { reason: 'cdpError' };
  }
  const stale = classifyStaleError(error);
  if (stale.stale) {
    return {
      reason:
        stale.kind === 'replaced'
          ? 'replaced'
          : stale.kind === 'context'
            ? 'navigation'
            : 'detached',
    };
  }
  return { reason: 'unknown' };
}

function getSuggestion(reason: FailureReason): string {
  switch (reason) {
    case 'missing':
      return "Element not found. Run 'snapshot' to see available elements, or try alternative selectors.";
    case 'hidden':
      return "Element exists but is not visible. Try 'scroll' or wait for it to appear.";
    case 'covered':
      return 'Element is blocked by another element. Dismiss the covering element first.';
    case 'disabled':
      return 'Element is disabled. Complete prerequisite steps to enable it.';
    case 'readonly':
      return 'Element is readonly and cannot be edited directly.';
    case 'detached':
      return "Element was removed from the DOM. Run 'snapshot' for fresh element refs.";
    case 'replaced':
      return "Element was replaced in the DOM. Run 'snapshot' to get updated refs.";
    case 'notEditable':
      return 'Element is not an editable field. Try a different selector targeting an input or textarea.';
    case 'timeout':
      return 'Timed out waiting. The page may still be loading. Try increasing timeout.';
    case 'navigation':
      return 'Navigation failed. Check the URL and network connectivity.';
    case 'cdpError':
      return "Browser connection error. Try 'bp connect' again.";
    case 'unknown':
      return "Unexpected error. Run 'snapshot' to check page state.";
    default: {
      const _exhaustive: never = reason;
      return `Unknown failure: ${_exhaustive}`;
    }
  }
}

function getDispatchSuggestion(receipt: ActionReceipt | undefined): string | undefined {
  if (receipt && receipt.dispatchState !== 'not_dispatched') {
    return 'Dispatch may have reached the browser. Verify the postcondition before another action.';
  }
  return undefined;
}

// Exported for testing
export { classifyFailure, getSuggestion };

/** Check if a step has any outcome conditions */
function hasOutcomeConditions(step: Step): boolean {
  return (
    (step.expectAny !== undefined && step.expectAny.length > 0) ||
    (step.expectAll !== undefined && step.expectAll.length > 0) ||
    (step.failIf !== undefined && step.failIf.length > 0)
  );
}

/** Check if any conditions need network tracking */
function needsNetworkTracking(step: Step): boolean {
  const allConditions: Condition[] = [
    ...(step.expectAny ?? []),
    ...(step.expectAll ?? []),
    ...(step.failIf ?? []),
  ];
  return allConditions.some((c) => c.kind === 'networkResponse');
}

/**
 * Which before-state signatures a step's `stateSignatureChanges` conditions
 * require. A condition compares its "after" capture against a like-for-like
 * "before" capture, so a `mode:'structure'` condition needs a structural
 * before-signature while the default (`mode:'text'`) needs the text one. A
 * step may contain both, so we capture each mode only when actually needed.
 */
function stateSignatureModes(step: Step): { text: boolean; structure: boolean } {
  const allConditions: Condition[] = [
    ...(step.expectAny ?? []),
    ...(step.expectAll ?? []),
    ...(step.failIf ?? []),
  ];
  let text = false;
  let structure = false;
  for (const c of allConditions) {
    if (c.kind !== 'stateSignatureChanges') continue;
    if (c.mode === 'structure') {
      structure = true;
    } else {
      text = true;
    }
  }
  return { text, structure };
}

function defaultActionEffect(action: ActionType): ActionEffect {
  switch (action) {
    case 'assertVisible':
    case 'assertExists':
    case 'assertText':
    case 'assertUrl':
    case 'assertValue':
    case 'assertTextChanged':
    case 'assertPermission':
    case 'assertMediaTrackLive':
    case 'assertNoConsoleErrors':
    case 'wait':
    case 'waitForReady':
    case 'snapshot':
    case 'forms':
    case 'text':
    case 'screenshot':
    case 'review':
    case 'delta':
    case 'waitForWsMessage':
      return 'observe';
    case 'click':
    case 'check':
    case 'uncheck':
    case 'submit':
    case 'press':
    case 'shortcut':
    case 'evaluate':
    case 'emit':
      return 'at_most_once';
    default:
      return 'idempotent';
  }
}

function receiptFor(page: Page): ActionReceipt | undefined {
  return page.getLastActionReceipt?.();
}

type OutcomeEvaluationOptions = Parameters<typeof evaluateOutcome>[1];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Re-check an outcome without re-running the action after dispatch. */
async function evaluateOutcomeWithObservation(
  page: Page,
  options: OutcomeEvaluationOptions,
  maxObservations: number,
  retryDelay: number
): Promise<Awaited<ReturnType<typeof evaluateOutcome>>> {
  let outcome = await evaluateOutcome(page, options);
  for (let observation = 1; observation < maxObservations; observation++) {
    if (outcome.outcomeStatus === 'success') break;
    await sleep(retryDelay);
    outcome = await evaluateOutcome(page, options);
  }
  return outcome;
}

export class BatchExecutor {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Execute a batch of steps
   */
  async execute(steps: Step[], options: BatchOptions = {}): Promise<BatchResult> {
    const { timeout = DEFAULT_TIMEOUT, onFail = 'stop' } = options;
    const results: StepResult[] = [];
    const startTime = Date.now();
    const executionId = createExecutionId();
    const recording = options.record
      ? this.createRecordingContext(options.record, executionId)
      : null;
    if (steps.some((step) => step.action === 'waitForWsMessage')) {
      await this.ensureTraceHooks();
    }
    const startUrl = recording ? await this.getPageUrlSafe() : '';
    let stoppedAtIndex: number | undefined;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const stepStart = Date.now();
      const maxAttempts = (step.retry ?? 0) + 1;
      const retryDelay = step.retryDelay ?? 500;
      const effect = step.effect ?? defaultActionEffect(step.action);

      let lastError: Error | undefined;
      let succeeded = false;
      let attemptsMade = 0;
      let lastReceipt: ActionReceipt | undefined;
      let lastOutcome: Awaited<ReturnType<typeof evaluateOutcome>> | undefined;
      let lastActionId: string | undefined;
      let lastRetryDecision: RetryDecision = {
        retry: false,
        reason: 'max_attempts_reached',
      };

      // Pre-step: set up outcome tracking if conditions are present
      const hasOutcome = hasOutcomeConditions(step);
      let networkTracker: NetworkResponseTracker | undefined;
      let beforeSignature: string | undefined;
      let beforeStructureSignature: string | undefined;
      let beforeState: AssertionBeforeState | undefined;
      const signatureModes = stateSignatureModes(step);

      if (hasOutcome) {
        if (needsNetworkTracking(step)) {
          networkTracker = new NetworkResponseTracker();
          networkTracker.start(this.page.cdpClient);
        }
        if (signatureModes.text) {
          beforeSignature = await captureStateSignature(this.page);
        }
        if (signatureModes.structure) {
          beforeStructureSignature = await captureStructureSignature(this.page);
        }
        const assertionConditions = [
          ...(step.expectAny ?? []),
          ...(step.expectAll ?? []),
          ...(step.failIf ?? []),
        ];
        if (
          assertionConditions.some((condition) =>
            ['fieldChanged', 'textChanges', 'urlChanged', 'newTarget'].includes(condition.kind)
          )
        ) {
          beforeState = await captureBeforeState(this.page, assertionConditions);
        }
      }

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          // Reset network tracker for retry
          if (networkTracker) networkTracker.reset();
        }

        const actionId = createActionId(executionId, i, attempt);
        lastActionId = actionId;
        if (recording) {
          recording.traceEvents.push(
            normalizeTraceEvent({
              traceId: createTraceId('action'),
              elapsedMs: Date.now() - startTime,
              channel: 'action',
              event: 'action.started',
              summary: `${step.action}${step.selector ? ` ${Array.isArray(step.selector) ? step.selector[0] : step.selector}` : ''}`,
              data: {
                action: step.action,
                selector: step.selector ?? null,
                url: step.url ?? null,
                attempt: attempt + 1,
                executionId,
                targetId: this.page.targetId,
              },
              actionId,
              executionId,
              attempt: attempt + 1,
              targetId: this.page.targetId,
              stepIndex: i,
              selector: step.selector,
              url: step.url,
            })
          );
        }

        try {
          attemptsMade = attempt + 1;
          this.page.resetLastActionPosition();
          this.page.resetLastActionReceipt?.();
          const result = await this.executeStep(step, timeout);
          const rawReceipt = result.receipt ?? receiptFor(this.page);
          lastReceipt = rawReceipt
            ? {
                ...rawReceipt,
                executionId,
                actionId,
                attempt: attempt + 1,
                targetId: this.page.targetId,
              }
            : undefined;

          const stepResult: StepResult = {
            index: i,
            action: step.action,
            selector: step.selector,
            selectorUsed: result.selectorUsed,
            effect,
            anchor: step.anchor,
            actionId,
            executionId,
            attempt: attempt + 1,
            targetId: this.page.targetId,
            targetProvenance: this.page.getTargetProvenance?.() as unknown as
              | Record<string, unknown>
              | undefined,
            success: true,
            durationMs: Date.now() - stepStart,
            result: result.value,
            text: result.text,
            timestamp: Date.now(),
            coordinates: this.page.getLastActionCoordinates() ?? undefined,
            boundingBox: this.page.getLastActionBoundingBox() ?? undefined,
            receipt: lastReceipt,
            dispatchState: lastReceipt?.dispatchState,
            retrySafe: lastReceipt?.retrySafe,
            attempts: attemptsMade,
            retryDecisionReason: 'not_needed_success',
          };

          // Post-step: evaluate outcome conditions
          if (hasOutcome) {
            const outcomeOptions = {
              expectAny: step.expectAny,
              expectAll: step.expectAll,
              failIf: step.failIf,
              dangerous: step.dangerous,
              networkTracker,
              beforeSignature,
              beforeStructureSignature,
              beforeState,
            } satisfies OutcomeEvaluationOptions;
            const observesAfterDispatch =
              lastReceipt?.dispatchState !== undefined &&
              lastReceipt.dispatchState !== 'not_dispatched';
            const outcome = observesAfterDispatch
              ? await evaluateOutcomeWithObservation(
                  this.page,
                  outcomeOptions,
                  maxAttempts - attempt,
                  retryDelay
                )
              : await evaluateOutcome(this.page, outcomeOptions);
            lastOutcome = outcome;
            stepResult.outcomeStatus = outcome.outcomeStatus;
            stepResult.matchedConditions = outcome.matchedConditions;
            stepResult.retrySafe = lastReceipt?.retrySafe ?? outcome.retrySafe;
            lastRetryDecision =
              outcome.outcomeStatus === 'success'
                ? { retry: false, reason: 'not_needed_success' }
                : shouldRetry({
                    effect,
                    dangerous: step.dangerous === true,
                    dispatchState: lastReceipt?.dispatchState,
                    retrySafe: lastReceipt?.retrySafe ?? outcome.retrySafe,
                    attempt,
                    maxAttempts,
                  });
            stepResult.retryDecisionReason = lastRetryDecision.reason;

            // If outcome is 'failed' or 'ambiguous'/'unsafe_to_retry', mark step as failed
            if (outcome.outcomeStatus !== 'success') {
              stepResult.success = false;
              stepResult.error = `Outcome: ${outcome.outcomeStatus}`;
              const failedDetails = outcome.matchedConditions
                .filter((mc) => (outcome.outcomeStatus === 'failed' ? mc.matched : !mc.matched))
                .map((mc) => mc.detail)
                .filter(Boolean);
              if (failedDetails.length > 0) {
                stepResult.suggestion = failedDetails.join('; ');
              }
              stepResult.suggestion = getDispatchSuggestion(lastReceipt) ?? stepResult.suggestion;
            }
          }

          if (recording && !recording.skipActions.has(step.action)) {
            await this.captureRecordingFrame(step, stepResult, recording);
          }
          if (recording) {
            recording.traceEvents.push(
              normalizeTraceEvent({
                traceId: createTraceId('action'),
                elapsedMs: Date.now() - startTime,
                channel: 'action',
                event: stepResult.success ? 'action.succeeded' : 'action.outcome_failed',
                summary: stepResult.success
                  ? `${step.action} succeeded`
                  : `${step.action} outcome: ${stepResult.outcomeStatus}`,
                data: {
                  action: step.action,
                  selector: step.selector ?? null,
                  selectorUsed: result.selectorUsed ?? null,
                  durationMs: Date.now() - stepStart,
                  outcomeStatus: stepResult.outcomeStatus ?? null,
                  attempts: attemptsMade,
                  retryDecisionReason: stepResult.retryDecisionReason ?? null,
                  receipt: lastReceipt ?? null,
                },
                actionId,
                executionId,
                attempt: attempt + 1,
                targetId: this.page.targetId,
                stepIndex: i,
                selector: step.selector,
                selectorUsed: result.selectorUsed,
                url: step.url,
              })
            );
          }

          // If step mechanically succeeded but outcome conditions failed
          if (hasOutcome && !stepResult.success) {
            if (lastRetryDecision.retry) {
              lastError = new Error(stepResult.error ?? 'Outcome failed');
              if (recording) {
                recording.traceEvents.push(
                  normalizeTraceEvent({
                    traceId: createTraceId('action'),
                    elapsedMs: Date.now() - startTime,
                    channel: 'action',
                    event: 'action.retrying',
                    summary: `${step.action} retrying: ${lastRetryDecision.reason}`,
                    data: {
                      action: step.action,
                      attempt: attemptsMade,
                      maxAttempts,
                      retryDecisionReason: lastRetryDecision.reason,
                      receipt: lastReceipt ?? null,
                    },
                    actionId,
                    executionId,
                    attempt: attempt + 1,
                    targetId: this.page.targetId,
                    stepIndex: i,
                    selector: step.selector,
                    url: step.url,
                  })
                );
              }
              continue;
            }
            results.push(stepResult);
            break;
          }

          results.push(stepResult);
          succeeded = true;
          break;
        } catch (error) {
          attemptsMade = attempt + 1;
          lastError = error instanceof Error ? error : new Error(String(error));
          const rawReceipt = receiptFor(this.page);
          lastReceipt = rawReceipt
            ? {
                ...rawReceipt,
                executionId,
                actionId,
                attempt: attempt + 1,
                targetId: this.page.targetId,
              }
            : undefined;

          // A transport/context error after dispatch is an observation failure,
          // not permission to redispatch. Give a configured postcondition one
          // chance to rescue the result on the new page.
          if (hasOutcome && lastReceipt && lastReceipt.dispatchState !== 'not_dispatched') {
            try {
              const receipt = lastReceipt;
              const outcomeOptions = {
                expectAny: step.expectAny,
                expectAll: step.expectAll,
                failIf: step.failIf,
                dangerous: step.dangerous,
                networkTracker,
                beforeSignature,
                beforeStructureSignature,
                beforeState,
              } satisfies OutcomeEvaluationOptions;
              const outcome = await evaluateOutcomeWithObservation(
                this.page,
                outcomeOptions,
                maxAttempts - attempt,
                retryDelay
              );
              lastOutcome = outcome;
              lastRetryDecision = shouldRetry({
                effect,
                dangerous: step.dangerous === true,
                dispatchState: receipt.dispatchState,
                retrySafe: receipt.retrySafe,
                attempt,
                maxAttempts,
              });

              if (outcome.outcomeStatus === 'success') {
                results.push({
                  index: i,
                  action: step.action,
                  selector: step.selector,
                  effect,
                  anchor: step.anchor,
                  success: true,
                  durationMs: Date.now() - stepStart,
                  receipt,
                  dispatchState: receipt.dispatchState,
                  attempts: attemptsMade,
                  retrySafe: receipt.retrySafe,
                  outcomeStatus: outcome.outcomeStatus,
                  matchedConditions: outcome.matchedConditions,
                  retryDecisionReason: 'not_needed_success',
                  timestamp: Date.now(),
                });
                succeeded = true;
                break;
              }
            } catch {
              // Keep the original transport error when observation is also
              // unavailable. The receipt still prevents a retry.
            }
          }

          lastRetryDecision = shouldRetry({
            effect,
            dangerous: step.dangerous === true,
            dispatchState: lastReceipt?.dispatchState,
            retrySafe: lastReceipt?.retrySafe,
            attempt,
            maxAttempts,
          });

          if (lastRetryDecision.retry) {
            if (recording) {
              recording.traceEvents.push(
                normalizeTraceEvent({
                  traceId: createTraceId('action'),
                  elapsedMs: Date.now() - startTime,
                  channel: 'action',
                  event: 'action.retrying',
                  summary: `${step.action} retrying: ${lastRetryDecision.reason}`,
                  data: {
                    action: step.action,
                    attempt: attemptsMade,
                    maxAttempts,
                    retryDecisionReason: lastRetryDecision.reason,
                    receipt: lastReceipt ?? null,
                  },
                  actionId,
                  executionId,
                  attempt: attempt + 1,
                  targetId: this.page.targetId,
                  stepIndex: i,
                  selector: step.selector,
                  url: step.url,
                })
              );
            }
            continue;
          }
          break;
        }
      }

      // Clean up network tracker if still active
      if (networkTracker) networkTracker.stop(this.page.cdpClient);

      if (!succeeded) {
        // Check if result was already pushed by outcome evaluation
        const resultAlreadyPushed = results.length > 0 && results[results.length - 1]!.index === i;

        if (!resultAlreadyPushed) {
          const errorMessage = lastError?.message ?? 'Unknown error';
          let hints = lastError instanceof ElementNotFoundError ? lastError.hints : undefined;
          const { reason, coveringElement } = classifyFailure(lastError);

          // Auto-generate hints on element-related failures
          if (
            step.selector &&
            !step.optional &&
            ['missing', 'hidden', 'covered', 'disabled', 'detached', 'replaced'].includes(reason)
          ) {
            try {
              const selectors = Array.isArray(step.selector) ? step.selector : [step.selector];
              const autoHints = await generateHints(this.page, selectors, step.action, 3);
              if (autoHints.length > 0) {
                hints = autoHints;
              }
            } catch {
              // Hint generation is best-effort
            }
          }

          const failedResult: StepResult = {
            index: i,
            action: step.action,
            selector: step.selector,
            effect,
            anchor: step.anchor,
            actionId: lastActionId,
            executionId,
            attempt: attemptsMade,
            targetId: this.page.targetId,
            targetProvenance: this.page.getTargetProvenance?.() as unknown as
              | Record<string, unknown>
              | undefined,
            success: false,
            durationMs: Date.now() - stepStart,
            error: errorMessage,
            hints,
            failureReason: reason,
            coveringElement,
            suggestion: getDispatchSuggestion(lastReceipt) ?? getSuggestion(reason),
            timestamp: Date.now(),
            receipt: lastReceipt,
            dispatchState: lastReceipt?.dispatchState,
            retrySafe: lastReceipt?.retrySafe,
            attempts: attemptsMade,
            retryDecisionReason: lastRetryDecision.reason,
            outcomeStatus: lastOutcome?.outcomeStatus,
            matchedConditions: lastOutcome?.matchedConditions,
          };

          if (recording && !recording.skipActions.has(step.action)) {
            await this.captureRecordingFrame(step, failedResult, recording);
          }
          if (recording) {
            recording.traceEvents.push(
              normalizeTraceEvent({
                traceId: createTraceId('action'),
                elapsedMs: Date.now() - startTime,
                channel: 'action',
                event: 'action.failed',
                severity: 'error',
                summary: `${step.action} failed: ${errorMessage}`,
                data: {
                  action: step.action,
                  selector: step.selector ?? null,
                  error: errorMessage,
                  reason,
                  attempts: attemptsMade,
                  retryDecisionReason: lastRetryDecision.reason,
                  receipt: lastReceipt ?? null,
                },
                actionId: lastActionId,
                executionId,
                attempt: attemptsMade,
                targetId: this.page.targetId,
                stepIndex: i,
                selector: step.selector,
                url: step.url,
              })
            );
          }

          results.push(failedResult);
        }

        if (onFail === 'stop' && !step.optional) {
          stoppedAtIndex = i;
          break;
        }
      }
    }

    const totalDurationMs = Date.now() - startTime;
    const allSuccess =
      stoppedAtIndex === undefined &&
      results.every((result) => result.success || steps[result.index]?.optional);
    let recordingManifest: string | undefined;
    if (recording) {
      recordingManifest = await this.writeRecordingManifest(
        recording,
        startTime,
        startUrl,
        allSuccess,
        steps
      );
    }

    return {
      success: allSuccess,
      stoppedAtIndex,
      steps: results,
      totalDurationMs,
      recordingManifest,
    };
  }

  private createRecordingContext(record: RecordOptions, executionId: string): RecordingContext {
    const baseDir = record.outputDir ?? join(process.cwd(), '.browser-pilot');
    const screenshotDir = join(baseDir, 'screenshots');
    const manifestPath = join(baseDir, 'recording.json');

    const existing = loadExistingRecording(manifestPath);

    fs.mkdirSync(screenshotDir, { recursive: true });

    return {
      baseDir,
      screenshotDir,
      sessionId: record.sessionId ?? this.page.targetId,
      frames: existing.frames,
      traceEvents: existing.traceEvents,
      format: record.format ?? 'webp',
      quality: Math.max(0, Math.min(100, record.quality ?? 40)),
      highlights: record.highlights !== false,
      skipActions: new Set(record.skipActions ?? DEFAULT_RECORDING_SKIP_ACTIONS),
      executionId,
      executions: existing.executions ?? [],
    };
  }

  private async getPageUrlSafe(): Promise<string> {
    try {
      return await this.page.url();
    } catch {
      return '';
    }
  }

  /**
   * Capture a recording screenshot frame with optional highlight overlay
   */
  private async captureRecordingFrame(
    step: Step,
    stepResult: StepResult,
    recording: RecordingContext
  ): Promise<void> {
    const targetMetadata = this.page.getLastActionTargetMetadata();
    let highlightInjected = false;

    try {
      const ts = Date.now();
      const seq = String(recording.frames.length + 1).padStart(4, '0');
      const filename = `${seq}-${ts}-${stepResult.action}.${recording.format}`;
      const filepath = join(recording.screenshotDir, filename);

      if (recording.highlights) {
        const kind = stepToHighlightKind(stepResult);
        if (kind) {
          await injectActionHighlight(this.page, {
            kind,
            bbox: stepResult.boundingBox,
            point: stepResult.coordinates,
            label: getHighlightLabel(step, stepResult, targetMetadata),
          });
          highlightInjected = true;
        }
      }

      const base64 = await this.page.screenshot({
        format: recording.format,
        quality: recording.quality,
      });
      const buffer = Buffer.from(base64, 'base64');
      fs.writeFileSync(filepath, buffer);
      stepResult.screenshotPath = filepath;

      let pageUrl: string | undefined;
      let pageTitle: string | undefined;
      try {
        pageUrl = await this.page.url();
        pageTitle = await this.page.title();
      } catch {
        /* best-effort */
      }

      recording.frames.push({
        seq: recording.frames.length + 1,
        timestamp: ts,
        action: stepResult.action,
        selector:
          stepResult.selectorUsed ??
          (Array.isArray(step.selector) ? step.selector[0] : step.selector),
        selectorUsed: stepResult.selectorUsed,
        value: redactValueForRecording(
          typeof step.value === 'string' ? step.value : undefined,
          targetMetadata
        ),
        url: step.url,
        coordinates: stepResult.coordinates,
        boundingBox: stepResult.boundingBox,
        success: stepResult.success,
        durationMs: stepResult.durationMs,
        error: stepResult.error,
        screenshot: filename,
        pageUrl,
        pageTitle,
        stepIndex: stepResult.index,
        actionId: stepResult.actionId,
        executionId: stepResult.executionId ?? recording.executionId,
        attempt: stepResult.attempt,
        dispatchState: stepResult.receipt?.dispatchState,
        retrySafe: stepResult.retrySafe,
        targetId: stepResult.targetId ?? this.page.targetId,
        effect: stepResult.effect,
        anchor: step.anchor,
      });
    } catch {
      /* Screenshot capture is best-effort. */
    } finally {
      if (recording.highlights || highlightInjected) {
        await removeActionHighlight(this.page);
      }
    }
  }

  /**
   * Write recording manifest to disk
   */
  private async writeRecordingManifest(
    recording: RecordingContext,
    startTime: number,
    startUrl: string,
    success: boolean,
    steps: Step[]
  ): Promise<string> {
    let endUrl = startUrl;

    try {
      endUrl = await this.page.url();
    } catch {
      /* best-effort */
    }

    // Preserve original recordedAt from existing manifest when accumulating
    const manifestPath = join(recording.baseDir, 'recording.json');
    let recordedAt = new Date(startTime).toISOString();
    let originalStartUrl = startUrl;
    const existing = loadExistingRecording(manifestPath);
    if (existing.recordedAt) recordedAt = existing.recordedAt;
    if (existing.startUrl) originalStartUrl = existing.startUrl;

    const manifest = createRecordingManifest({
      recordedAt,
      sessionId: recording.sessionId,
      startUrl: originalStartUrl,
      endUrl,
      targetId: this.page.targetId,
      steps,
      frames: recording.frames,
      traceEvents: recording.traceEvents,
      notes: success ? [] : ['Replay ended with at least one failed action.'],
      recordingManifest: 'recording.json',
      screenshotDir: 'screenshots/',
      executionId: recording.executionId,
      executions: recording.executions,
    });

    const integrity = validateRecordingManifest(manifest);
    if (!integrity.valid) {
      throw new Error(`Recording manifest integrity failure: ${integrity.errors.join('; ')}`);
    }
    for (const screenshot of manifest.screenshots) {
      const screenshotPath = join(recording.screenshotDir, screenshot.file);
      if (!fs.existsSync(screenshotPath) || fs.statSync(screenshotPath).size === 0) {
        throw new Error(`Recording screenshot evidence is missing: ${screenshot.file}`);
      }
    }
    // Rename within the same directory so readers never observe a partial
    // manifest while another execution is appending evidence.
    const temporaryPath = `${manifestPath}.tmp-${recording.executionId}`;
    fs.writeFileSync(temporaryPath, JSON.stringify(manifest, null, 2));
    fs.renameSync(temporaryPath, manifestPath);
    return manifestPath;
  }

  /**
   * Execute a single step
   */
  private async executeStep(
    step: Step,
    defaultTimeout: number
  ): Promise<{
    selectorUsed?: string;
    value?: unknown;
    text?: string;
    receipt?: ActionReceipt;
  }> {
    const timeout = step.timeout ?? defaultTimeout;
    const optional = step.optional ?? false;

    switch (step.action) {
      case 'goto': {
        if (!step.url) throw new Error('goto requires url');
        await this.page.goto(step.url, { timeout, optional, waitUntil: step.waitUntil });
        return {};
      }

      case 'click': {
        if (!step.selector) throw new Error('click requires selector');

        // If waitForNavigation is set, set up listener BEFORE clicking
        if (step.waitForNavigation === true) {
          const navPromise = this.page.waitForNavigation({
            timeout,
            optional,
            waitUntil: step.waitUntil,
          });
          await this.page.click(step.selector, { timeout, optional });
          const observed = await navPromise;
          if (observed) this.page.markLastActionNavigationObserved?.();
        } else {
          await this.page.click(step.selector, { timeout, optional });
        }

        return {
          selectorUsed: this.getUsedSelector(step.selector),
          receipt: receiptFor(this.page),
        };
      }

      case 'fill': {
        if (!step.selector) throw new Error('fill requires selector');
        if (typeof step.value !== 'string') throw new Error('fill requires string value');
        await this.page.fill(step.selector, step.value, {
          timeout,
          optional,
          blur: step.blur,
          verify: step.verify,
        });
        return {
          selectorUsed: this.getUsedSelector(step.selector),
          receipt: receiptFor(this.page),
        };
      }

      case 'type': {
        if (!step.selector) throw new Error('type requires selector');
        if (typeof step.value !== 'string') throw new Error('type requires string value');
        await this.page.type(step.selector, step.value, {
          timeout,
          optional,
          delay: step.delay ?? 50,
        });
        return {
          selectorUsed: this.getUsedSelector(step.selector),
          receipt: receiptFor(this.page),
        };
      }

      case 'select': {
        // Custom select (with trigger and option)
        if (step.trigger && step.option && typeof step.value === 'string') {
          await this.page.select(
            {
              trigger: step.trigger,
              option: step.option,
              value: step.value,
              match: step.match as 'text' | 'value' | 'contains' | undefined,
            },
            { timeout, optional }
          );
          return {
            selectorUsed: this.getUsedSelector(step.trigger),
            receipt: receiptFor(this.page),
          };
        }

        // Native select
        if (!step.selector) throw new Error('select requires selector');
        if (!step.value) throw new Error('select requires value');
        await this.page.select(step.selector, step.value, { timeout, optional });
        return {
          selectorUsed: this.getUsedSelector(step.selector),
          receipt: receiptFor(this.page),
        };
      }

      case 'check': {
        if (!step.selector) throw new Error('check requires selector');
        await this.page.check(step.selector, { timeout, optional });
        return {
          selectorUsed: this.getUsedSelector(step.selector),
          receipt: receiptFor(this.page),
        };
      }

      case 'uncheck': {
        if (!step.selector) throw new Error('uncheck requires selector');
        await this.page.uncheck(step.selector, { timeout, optional });
        return {
          selectorUsed: this.getUsedSelector(step.selector),
          receipt: receiptFor(this.page),
        };
      }

      case 'submit': {
        if (!step.selector) throw new Error('submit requires selector');
        await this.page.submit(step.selector, {
          timeout,
          optional,
          method: step.method ?? 'enter+click',
          waitForNavigation: step.waitForNavigation,
          waitUntil: step.waitUntil,
        });
        return {
          selectorUsed: this.getUsedSelector(step.selector),
          receipt: receiptFor(this.page),
        };
      }

      case 'press': {
        if (!step.key) throw new Error('press requires key');
        try {
          await this.page.press(step.key, {
            modifiers: step.modifiers,
          });
        } catch (e) {
          if (optional) return {};
          throw e;
        }
        return { receipt: receiptFor(this.page) };
      }

      case 'shortcut': {
        if (!step.combo) throw new Error('shortcut requires combo');
        try {
          await this.page.shortcut(step.combo);
        } catch (e) {
          if (optional) return {};
          throw e;
        }
        return { receipt: receiptFor(this.page) };
      }

      case 'focus': {
        if (!step.selector) throw new Error('focus requires selector');
        await this.page.focus(step.selector, { timeout, optional });
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'hover': {
        if (!step.selector) throw new Error('hover requires selector');
        await this.page.hover(step.selector, { timeout, optional });
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'scroll': {
        // Scroll to absolute coordinates
        if (step.x !== undefined || step.y !== undefined) {
          await this.page.scroll('body', { x: step.x, y: step.y, timeout, optional });
          return {};
        }
        // Page-level scroll with direction (no selector needed)
        if (!step.selector && (step.direction || step.amount !== undefined)) {
          const amount = step.amount ?? 500;
          const direction = step.direction ?? 'down';
          const deltaY = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
          const deltaX = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
          await this.page.evaluate(`window.scrollBy(${deltaX}, ${deltaY})`);
          return {};
        }
        if (!step.selector) throw new Error('scroll requires selector, coordinates, or direction');
        await this.page.scroll(step.selector, { timeout, optional });
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'wait': {
        // Simple timeout wait (no selector, no waitFor)
        if (
          !step.selector &&
          !step.waitFor &&
          !step.any &&
          !step.all &&
          !step.loadingHidden &&
          !step.predicate &&
          step.stableForMs === undefined &&
          step.domQuietForMs === undefined
        ) {
          const delay = step.timeout ?? 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          return {};
        }
        if (step.waitFor === 'navigation') {
          await this.page.waitForNavigation({ timeout, optional, waitUntil: step.waitUntil });
          return {};
        }
        if (step.waitFor === 'networkIdle') {
          await this.page.waitForNetworkIdle({ timeout, optional });
          return {};
        }
        if (step.waitFor === 'ready') {
          const selectorConditions = step.selector
            ? Array.isArray(step.selector)
              ? step.selector
              : [step.selector]
            : [];
          await this.page.waitForReady({
            any: step.any ?? selectorConditions,
            all: step.all,
            loadingHidden: step.loadingHidden,
            predicate: step.predicate,
            stableForMs: step.stableForMs,
            domQuietForMs: step.domQuietForMs,
            pollInterval: step.pollInterval,
            timeout,
            optional,
          });
          return { value: this.page.getReadinessDiagnostics?.() };
        }
        if (!step.selector)
          throw new Error(
            'wait requires selector (or waitFor: navigation/networkIdle/ready, or timeout for simple delay)'
          );
        await this.page.waitFor(step.selector, {
          timeout,
          optional,
          state: step.waitFor ?? 'visible',
        });
        return {
          selectorUsed: Array.isArray(step.selector) ? step.selector[0]! : step.selector,
        };
      }

      case 'waitForReady': {
        const selectorConditions = step.selector
          ? Array.isArray(step.selector)
            ? step.selector
            : [step.selector]
          : [];
        await this.page.waitForReady({
          any: step.any ?? selectorConditions,
          all: step.all,
          loadingHidden: step.loadingHidden,
          predicate: step.predicate,
          stableForMs: step.stableForMs,
          domQuietForMs: step.domQuietForMs,
          pollInterval: step.pollInterval,
          timeout,
          optional,
        });
        return { value: this.page.getReadinessDiagnostics?.() };
      }

      case 'snapshot': {
        const snapshot = await this.page.snapshot();
        return { value: snapshot };
      }

      case 'forms': {
        return { value: await this.page.forms() };
      }

      case 'delta': {
        const review = await this.page.review();
        return { value: review };
      }

      case 'review': {
        const review = await this.page.review();
        return { value: review };
      }

      case 'screenshot': {
        const data = await this.page.screenshot({
          format: step.format,
          quality: step.quality,
          fullPage: step.fullPage,
        });
        return { value: data };
      }

      case 'evaluate': {
        if (typeof step.value !== 'string')
          throw new Error('evaluate requires string value (expression)');
        const result = await this.page.evaluate(step.value);
        return { value: result };
      }

      case 'text': {
        // text() only accepts a single selector string, use first if array provided
        const selector = Array.isArray(step.selector) ? step.selector[0] : step.selector;
        const text = await this.page.text(selector);
        return { text, selectorUsed: selector };
      }

      case 'newTab': {
        const { targetId } = await this.page.cdpClient.send<{ targetId: string }>(
          'Target.createTarget',
          {
            url: step.url ?? 'about:blank',
            background: step.background ?? true,
          },
          null
        );
        return { value: { targetId } };
      }

      case 'closeTab': {
        const targetId = step.targetId ?? this.page.targetId;
        await this.page.cdpClient.send('Target.closeTarget', { targetId }, null);
        return { value: { targetId, closedCurrent: targetId === this.page.targetId } };
      }

      case 'switchFrame': {
        if (!step.selector) throw new Error('switchFrame requires selector');
        await this.page.switchToFrame(step.selector, { timeout, optional });
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'switchToMain': {
        await this.page.switchToMain();
        return {};
      }

      case 'assertVisible': {
        if (!step.selector) throw new Error('assertVisible requires selector');
        const el = await this.page.waitFor(step.selector, {
          timeout,
          optional: true,
          state: 'visible',
        });
        if (!el) {
          throw new Error(
            `Assertion failed: selector ${JSON.stringify(step.selector)} is not visible`
          );
        }
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'assertExists': {
        if (!step.selector) throw new Error('assertExists requires selector');
        const el = await this.page.waitFor(step.selector, {
          timeout,
          optional: true,
          state: 'attached',
        });
        if (!el) {
          throw new Error(
            `Assertion failed: selector ${JSON.stringify(step.selector)} does not exist`
          );
        }
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'assertText': {
        const selector = Array.isArray(step.selector) ? step.selector[0] : step.selector;
        const text = await this.page.text(selector);
        const expected = step.expect ?? step.value;
        if (typeof expected !== 'string') throw new Error('assertText requires expect or value');
        const scopedText = step.landmark
          ? await readScopedText(this.page, selector, step.scope, step.landmark)
          : text;
        const mode = step.textMode ?? 'contains';
        if (!matchText(scopedText, expected, mode)) {
          throw new Error(
            `Assertion failed: text does not ${mode === 'contains' ? 'contain' : `match (${mode})`} ${JSON.stringify(expected)}. Got: ${JSON.stringify(scopedText.slice(0, 200))}`
          );
        }
        return { selectorUsed: selector, text: scopedText };
      }

      case 'assertUrl': {
        const currentUrl = await this.page.url();
        const expected = step.expect ?? step.url;
        if (typeof expected !== 'string') throw new Error('assertUrl requires expect or url');
        const mode = step.urlMode ?? 'contains';
        if (!matchUrl(currentUrl, expected, mode)) {
          throw new Error(
            `Assertion failed: URL does not ${mode === 'contains' ? 'contain' : `match (${mode})`} ${JSON.stringify(expected)}. Got: ${JSON.stringify(currentUrl)}`
          );
        }
        return { value: currentUrl };
      }

      case 'assertValue': {
        if (!step.selector) throw new Error('assertValue requires selector');
        const expected = step.expect ?? step.value;
        if (typeof expected !== 'string') throw new Error('assertValue requires expect or value');
        const found = await this.page.waitFor(step.selector, {
          timeout,
          optional: true,
          state: 'attached',
        });
        if (!found) {
          throw new Error(`Assertion failed: selector ${JSON.stringify(step.selector)} not found`);
        }
        const usedSelector = this.getUsedSelector(step.selector);
        const actual = step.landmark
          ? (await readScopedElementState(this.page, usedSelector, step.landmark)).value
          : await this.page.evaluate(
              `(function() { var el = document.querySelector(${JSON.stringify(usedSelector)}); return el ? el.value : null; })()`
            );
        if (actual !== expected) {
          throw new Error(
            `Assertion failed: value of ${JSON.stringify(usedSelector)} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`
          );
        }
        return { selectorUsed: usedSelector, value: actual };
      }

      case 'waitForWsMessage': {
        if (typeof step.match !== 'string') {
          throw new Error('waitForWsMessage requires match');
        }
        const message = await this.waitForWsMessage(step.match, step.where, timeout);
        return { value: message };
      }

      case 'emit': {
        if (step.payload === undefined) {
          throw new Error('emit requires payload');
        }
        const channel = step.channel ?? 'ws';
        if (channel !== 'ws') {
          throw new Error(`emit supports channel "ws", got "${channel}"`);
        }
        const body = typeof step.payload === 'string' ? step.payload : JSON.stringify(step.payload);

        const result = await this.page.emitMessage(body, {
          ...(typeof step.match === 'string' ? { match: step.match } : {}),
          ...(step.base64 ? { base64: true } : {}),
          ...(step.awaitReply ? { awaitReply: { timeout, ...step.awaitReply } } : {}),
        });

        // A requested reply that never arrived is a failed step, not a quiet
        // success - the point of awaitReply is evidence the server acted.
        if (step.awaitReply && !result.reply) {
          throw new Error(
            `emit sent on ${result.socketUrl} but no matching reply arrived within ${step.awaitReply.timeout ?? timeout}ms`
          );
        }
        return { value: result };
      }

      case 'assertNoConsoleErrors': {
        await this.assertNoConsoleErrors(step.windowMs ?? timeout);
        return {};
      }

      case 'assertTextChanged': {
        const selector = Array.isArray(step.selector) ? step.selector[0] : step.selector;
        if (typeof step.to !== 'string') {
          throw new Error('assertTextChanged requires to');
        }
        const text = await this.assertTextChanged(selector, step.from, step.to, timeout);
        return { selectorUsed: selector, text };
      }

      case 'assertPermission': {
        if (!step.name || !step.state) {
          throw new Error('assertPermission requires name and state');
        }
        const permission = await this.assertPermission(step.name, step.state);
        return { value: permission };
      }

      case 'assertMediaTrackLive': {
        if (!step.kind) {
          throw new Error('assertMediaTrackLive requires kind');
        }
        const media = await this.assertMediaTrackLive(step.kind);
        return { value: media };
      }

      case 'chooseOption': {
        const { chooseOption } = await import('../browser/combobox.ts');
        if (!step.value) throw new Error('chooseOption requires value');
        const result = await chooseOption(this.page, {
          trigger: step.trigger ?? step.selector ?? '',
          listbox: step.option
            ? Array.isArray(step.option)
              ? step.option
              : [step.option]
            : undefined,
          value: typeof step.value === 'string' ? step.value : (step.value[0] ?? ''),
          match: step.match as 'exact' | 'contains' | 'startsWith' | undefined,
          timeout: step.timeout ?? timeout,
        });
        if (!result.success) {
          throw new Error(result.error ?? `chooseOption failed at ${result.failedAt}`);
        }
        return { value: result };
      }

      case 'upload': {
        const { uploadFiles } = await import('../browser/upload.ts');
        if (!step.selector) throw new Error('upload requires selector');
        if (!step.files || step.files.length === 0) throw new Error('upload requires files');
        const result = await uploadFiles(this.page, {
          selector: step.selector,
          files: step.files,
          timeout: step.timeout ?? timeout,
        });
        if (!result.accepted) {
          throw new Error(result.error ?? 'Upload was not accepted');
        }
        return { value: result };
      }

      case 'setCookie': {
        if (
          !step.cookie ||
          typeof step.cookie.name !== 'string' ||
          typeof step.cookie.value !== 'string'
        ) {
          throw new Error('setCookie requires cookie: { name, value, ... }');
        }
        const success = await this.page.setCookie(step.cookie);
        return { value: { success } };
      }

      case 'setHeaders': {
        if (!step.headers || typeof step.headers !== 'object' || Array.isArray(step.headers)) {
          throw new Error('setHeaders requires headers: Record<string, string>');
        }
        await this.page.setExtraHTTPHeaders(step.headers);
        return {};
      }

      default: {
        const action = step.action as string;
        const aliases: Record<string, string> = {
          execute: 'evaluate',
          navigate: 'goto',
          input: 'fill',
          tap: 'click',
          go: 'goto',
          run: 'evaluate',
          capture: 'screenshot',
          inspect: 'snapshot',
          enter: 'press',
          keypress: 'press',
          hotkey: 'shortcut',
          keybinding: 'shortcut',
          nav: 'goto',
          open: 'goto',
          visit: 'goto',
          browse: 'goto',
          load: 'goto',
          write: 'fill',
          set: 'fill',
          pick: 'select',
          choose: 'select',
          send: 'press',
          eval: 'evaluate',
          js: 'evaluate',
          script: 'evaluate',
          snap: 'snapshot',
          accessibility: 'snapshot',
          a11y: 'snapshot',
          formslist: 'forms',
          image: 'screenshot',
          pic: 'screenshot',
          frame: 'switchFrame',
          iframe: 'switchFrame',
          newtab: 'newTab',
          opentab: 'newTab',
          createtab: 'newTab',
          closetab: 'closeTab',
          assert_visible: 'assertVisible',
          assert_exists: 'assertExists',
          assert_text: 'assertText',
          assert_url: 'assertUrl',
          assert_value: 'assertValue',
          checkvisible: 'assertVisible',
          checkexists: 'assertExists',
          checktext: 'assertText',
          checkurl: 'assertUrl',
          checkvalue: 'assertValue',
        };
        const suggestion = aliases[action.toLowerCase()];
        const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
        const valid =
          'goto, click, fill, type, select, check, uncheck, submit, press, shortcut, focus, hover, scroll, wait, snapshot, forms, screenshot, evaluate, text, newTab, closeTab, switchFrame, switchToMain, assertVisible, assertExists, assertText, assertUrl, assertValue, waitForWsMessage, assertNoConsoleErrors, assertTextChanged, assertPermission, assertMediaTrackLive';
        throw new Error(`Unknown action "${action}".${hint}\n\nValid actions: ${valid}`);
      }
    }
  }

  /**
   * Get the actual selector that matched the element.
   * Uses the last matched selector tracked by Page, falls back to first selector if unavailable.
   */
  private getUsedSelector(selector: string | string[]): string {
    const matched = this.page.getLastMatchedSelector();
    if (matched) return matched;
    // Fallback for actions that don't track selector
    return Array.isArray(selector) ? selector[0]! : selector;
  }

  private async ensureTraceHooks(): Promise<void> {
    await this.page.cdpClient.send('Runtime.enable');
    await this.page.cdpClient.send('Page.enable');
    await this.page.cdpClient.send('Network.enable');
    try {
      await this.page.cdpClient.send('Runtime.addBinding', { name: TRACE_BINDING_NAME });
    } catch {
      // already installed
    }
    await this.page.cdpClient.send('Page.addScriptToEvaluateOnNewDocument', {
      source: TRACE_SCRIPT,
    });
    await this.page.cdpClient.send('Runtime.evaluate', {
      expression: TRACE_SCRIPT,
      awaitPromise: false,
    });
  }

  private async waitForWsMessage(
    match: string,
    where: Record<string, unknown> | undefined,
    timeout: number
  ): Promise<Record<string, unknown>> {
    await this.ensureTraceHooks();
    const regex = globToRegex(match);
    const wsUrls = new Map<string, string>();
    const recentMatch = await this.findRecentWsMessage(regex, where);
    if (recentMatch) {
      return recentMatch;
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const cleanup = () => {
        this.page.cdpClient.off('Network.webSocketCreated', onCreated);
        this.page.cdpClient.off('Network.webSocketFrameReceived', onFrame);
        this.page.cdpClient.off('Runtime.bindingCalled', onBinding);
        clearTimeout(timer);
      };

      const onCreated = (params: Record<string, unknown>) => {
        wsUrls.set(readStringOr(params['requestId']), readStringOr(params['url']));
      };

      const onFrame = (params: Record<string, unknown>) => {
        const requestId = readStringOr(params['requestId']);
        const response = (params['response'] ?? {}) as { payloadData?: string };
        const payload = response.payloadData ?? '';
        const url = wsUrls.get(requestId) ?? '';
        if (!regex.test(url) && !regex.test(payload)) {
          return;
        }

        if (where && !this.payloadMatchesWhere(payload, where)) {
          return;
        }

        cleanup();
        resolve({ requestId, url, payload });
      };

      const onBinding = (params: Record<string, unknown>) => {
        if (params['name'] !== TRACE_BINDING_NAME) {
          return;
        }

        try {
          const parsed = JSON.parse(readStringOr(params['payload'])) as {
            event?: string;
            data?: Record<string, unknown>;
          };
          if (parsed.event !== 'ws.frame.received') {
            return;
          }

          const data = parsed.data ?? {};
          const payload = readStringOr(data['payload']);
          const url = readStringOr(data['url']);
          if (!regex.test(url) && !regex.test(payload)) {
            return;
          }

          if (where && !this.payloadMatchesWhere(payload, where)) {
            return;
          }

          cleanup();
          resolve({
            requestId: readStringOr(data['connectionId']),
            url,
            payload,
          });
        } catch {
          // ignore malformed trace payloads
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for WebSocket message matching ${match}`));
      }, timeout);

      this.page.cdpClient.on('Network.webSocketCreated', onCreated);
      this.page.cdpClient.on('Network.webSocketFrameReceived', onFrame);
      this.page.cdpClient.on('Runtime.bindingCalled', onBinding);
    });
  }

  private payloadMatchesWhere(payload: string, where: Record<string, unknown>): boolean {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      return Object.entries(where).every(([key, expected]) => {
        const actual = key.split('.').reduce<unknown>((current, part) => {
          if (!current || typeof current !== 'object') {
            return undefined;
          }
          return (current as Record<string, unknown>)[part];
        }, parsed);
        return actual === expected;
      });
    } catch {
      return false;
    }
  }

  private async findRecentWsMessage(
    regex: RegExp,
    where: Record<string, unknown> | undefined
  ): Promise<Record<string, unknown> | null> {
    const recent = await this.page.evaluate<unknown[]>(
      '(() => Array.isArray(globalThis.__bpTraceRecentEvents) ? globalThis.__bpTraceRecentEvents : [])()'
    );
    if (!Array.isArray(recent)) {
      return null;
    }

    for (let i = recent.length - 1; i >= 0; i--) {
      const entry = recent[i];
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const event = readStringOr(record['event']);
      if (event !== 'ws.frame.received') {
        continue;
      }
      const data = (record['data'] ?? {}) as Record<string, unknown>;
      const payload = readStringOr(data['payload']);
      const url = readStringOr(data['url']);
      if (!regex.test(url) && !regex.test(payload)) {
        continue;
      }
      if (where && !this.payloadMatchesWhere(payload, where)) {
        continue;
      }
      return {
        requestId: readStringOr(data['connectionId']),
        url,
        payload,
      };
    }

    return null;
  }

  private async assertNoConsoleErrors(windowMs: number): Promise<void> {
    await this.page.cdpClient.send('Runtime.enable');

    return new Promise<void>((resolve, reject) => {
      const errors: string[] = [];

      const cleanup = () => {
        this.page.cdpClient.off('Runtime.consoleAPICalled', onConsole);
        this.page.cdpClient.off('Runtime.exceptionThrown', onException);
        clearTimeout(timer);
      };

      const onConsole = (params: Record<string, unknown>) => {
        if (params['type'] !== 'error') {
          return;
        }
        const args = Array.isArray(params['args'])
          ? (params['args'] as Array<Record<string, unknown>>)
          : [];
        errors.push(args.map(formatConsoleArg).filter(Boolean).join(' '));
      };

      const onException = (params: Record<string, unknown>) => {
        const details = (params['exceptionDetails'] ?? {}) as Record<string, unknown>;
        errors.push(readString(details['text']) ?? 'Runtime exception');
      };

      const timer = setTimeout(() => {
        cleanup();
        if (errors.length > 0) {
          reject(new Error(`Console errors detected: ${errors.join(' | ')}`));
          return;
        }
        resolve();
      }, windowMs);

      this.page.cdpClient.on('Runtime.consoleAPICalled', onConsole);
      this.page.cdpClient.on('Runtime.exceptionThrown', onException);
    });
  }

  private async assertTextChanged(
    selector: string | undefined,
    from: string | undefined,
    to: string,
    timeout: number,
    mode: import('./types.ts').TextMatchMode = 'contains',
    scope?: import('./types.ts').AssertionScope,
    landmark?: string
  ): Promise<string> {
    const initialText = from ?? (await readScopedText(this.page, selector, scope, landmark));
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const text = await readScopedText(this.page, selector, scope, landmark);
      if (text !== initialText && matchText(text, to, mode)) {
        return text;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    throw new Error(`Text did not change to include ${JSON.stringify(to)}`);
  }

  private async assertPermission(name: string, state: string): Promise<Record<string, unknown>> {
    const result = await this.page.evaluate(
      `(() => navigator.permissions.query({ name: ${JSON.stringify(name)} }).then((status) => ({ name: ${JSON.stringify(name)}, state: status.state })))()`
    );
    if (!result || typeof result !== 'object' || (result as { state?: unknown }).state !== state) {
      throw new Error(`Permission ${name} is not ${state}`);
    }
    return result as Record<string, unknown>;
  }

  private async assertMediaTrackLive(kind: 'audio' | 'video'): Promise<Record<string, unknown>> {
    const result = await this.page.evaluate(
      `(() => {
        const requestedKind = ${JSON.stringify(kind)};
        const mediaElements = Array.from(document.querySelectorAll('audio,video')).map((el) => {
          const tracks = [];
          if (el.srcObject && typeof el.srcObject.getTracks === 'function') {
            tracks.push(...el.srcObject.getTracks());
          }
          return {
            tag: el.tagName.toLowerCase(),
            paused: !!el.paused,
            tracks: tracks.map((track) => ({
              kind: track.kind,
              readyState: track.readyState,
              enabled: track.enabled,
              label: track.label,
            })),
          };
        });

        const globalTracks =
          window.__bpStream && typeof window.__bpStream.getTracks === 'function'
            ? window.__bpStream.getTracks().map((track) => ({
                kind: track.kind,
                readyState: track.readyState,
                enabled: track.enabled,
                label: track.label,
              }))
            : [];

        const liveTracks = mediaElements
          .flatMap((entry) => entry.tracks)
          .concat(globalTracks)
          .filter((track) => track.kind === requestedKind && track.readyState === 'live');

        return { live: liveTracks.length > 0, mediaElements, globalTracks, liveTracks };
      })()`
    );

    if (!result || typeof result !== 'object' || !(result as { live?: boolean }).live) {
      throw new Error(`No live ${kind} media track detected`);
    }

    return result as Record<string, unknown>;
  }
}

/**
 * Add batch execution capability to Page class
 */
export function addBatchToPage(
  page: Page
): Page & { batch: (steps: Step[], options?: BatchOptions) => Promise<BatchResult> } {
  const executor = new BatchExecutor(page);

  return Object.assign(page, {
    batch: (steps: Step[], options?: BatchOptions) => executor.execute(steps, options),
  });
}
