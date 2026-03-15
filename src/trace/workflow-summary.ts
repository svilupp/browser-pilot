/**
 * Workflow summary — business-readable execution evidence
 */

import type { BatchResult, MatchedCondition, StepResult } from '../actions/types.ts';

export interface WorkflowStepSummary {
  /** Step number (1-based) */
  step: number;
  /** Human-readable description */
  description: string;
  /** Whether this step succeeded */
  success: boolean;
  /** Duration in ms */
  durationMs: number;
  /** Outcome status if conditions were evaluated */
  outcomeStatus?: string;
  /** Summary of matched conditions */
  outcomeEvidence?: string[];
  /** Whether safe to retry */
  retrySafe?: boolean;
  /** Error if failed */
  error?: string;
  /** Suggestion for next action */
  suggestion?: string;
}

export interface WorkflowSummary {
  /** Whether the entire workflow succeeded */
  success: boolean;
  /** Total steps */
  totalSteps: number;
  /** Steps that succeeded */
  succeededSteps: number;
  /** Steps that failed */
  failedSteps: number;
  /** Total duration */
  totalDurationMs: number;
  /** Per-step summaries */
  steps: WorkflowStepSummary[];
  /** Overall verdict */
  verdict: string;
  /** Retry safety of the entire workflow */
  workflowRetrySafe: boolean;
}

/**
 * Generate a human-readable description for a step
 */
function describeStep(result: StepResult): string {
  const action = result.action;
  const selector =
    result.selectorUsed ?? (Array.isArray(result.selector) ? result.selector[0] : result.selector);

  switch (action) {
    case 'goto':
      return 'Navigate to page';
    case 'click':
      return `Click ${selector ? `"${selector}"` : 'element'}`;
    case 'fill':
      return `Fill ${selector ? `"${selector}"` : 'field'}`;
    case 'type':
      return `Type into ${selector ? `"${selector}"` : 'field'}`;
    case 'select':
      return `Select option in ${selector ? `"${selector}"` : 'dropdown'}`;
    case 'submit':
      return `Submit ${selector ? `"${selector}"` : 'form'}`;
    case 'check':
      return `Check ${selector ? `"${selector}"` : 'checkbox'}`;
    case 'uncheck':
      return `Uncheck ${selector ? `"${selector}"` : 'checkbox'}`;
    case 'press':
      return 'Press key';
    case 'shortcut':
      return 'Keyboard shortcut';
    case 'hover':
      return `Hover over ${selector ? `"${selector}"` : 'element'}`;
    case 'scroll':
      return `Scroll ${selector ? `"${selector}"` : 'page'}`;
    case 'wait':
      return `Wait for ${selector ? `"${selector}"` : 'condition'}`;
    case 'snapshot':
      return 'Capture accessibility snapshot';
    case 'screenshot':
      return 'Take screenshot';
    case 'forms':
      return 'Enumerate form fields';
    case 'evaluate':
      return 'Execute JavaScript';
    case 'text':
      return 'Extract text content';
    case 'review':
      return 'Extract page review';
    case 'delta':
      return 'Capture page delta';
    default:
      return `${action}${selector ? ` "${selector}"` : ''}`;
  }
}

/**
 * Summarize matched conditions into human-readable strings
 */
function summarizeConditions(conditions: MatchedCondition[]): string[] {
  return conditions
    .filter((c) => c.detail)
    .map((c) => {
      const status = c.matched ? '\u2713' : '\u2717';
      return `${status} ${c.detail}`;
    });
}

/**
 * Build a workflow summary from a batch result
 */
export function buildWorkflowSummary(result: BatchResult): WorkflowSummary {
  const steps: WorkflowStepSummary[] = result.steps.map((s) => {
    const step: WorkflowStepSummary = {
      step: s.index + 1,
      description: describeStep(s),
      success: s.success,
      durationMs: s.durationMs,
    };

    if (s.outcomeStatus) {
      step.outcomeStatus = s.outcomeStatus;
      step.retrySafe = s.retrySafe;
    }

    if (s.matchedConditions && s.matchedConditions.length > 0) {
      step.outcomeEvidence = summarizeConditions(s.matchedConditions);
    }

    if (s.error) step.error = s.error;
    if (s.suggestion) step.suggestion = s.suggestion;

    return step;
  });

  const succeededSteps = steps.filter((s) => s.success).length;
  const failedSteps = steps.filter((s) => !s.success).length;

  // Determine if workflow is safe to retry
  const hasUnsafeStep = steps.some(
    (s) => s.retrySafe === false || s.outcomeStatus === 'unsafe_to_retry'
  );
  const workflowRetrySafe = !hasUnsafeStep;

  // Generate verdict
  let verdict: string;
  if (result.success) {
    verdict = `Workflow completed successfully (${succeededSteps}/${steps.length} steps)`;
  } else if (result.stoppedAtIndex !== undefined) {
    const failedStep = steps[result.stoppedAtIndex];
    verdict = `Workflow stopped at step ${result.stoppedAtIndex + 1}: ${failedStep?.description ?? 'unknown'}`;
    if (failedStep?.outcomeStatus) {
      verdict += ` (outcome: ${failedStep.outcomeStatus})`;
    }
  } else {
    verdict = `Workflow completed with ${failedSteps} failure(s)`;
  }

  return {
    success: result.success,
    totalSteps: steps.length,
    succeededSteps,
    failedSteps,
    totalDurationMs: result.totalDurationMs,
    steps,
    verdict,
    workflowRetrySafe,
  };
}

/**
 * Format a workflow summary as a compact text report
 */
export function formatWorkflowSummary(summary: WorkflowSummary): string {
  const lines: string[] = [];

  lines.push(`## Workflow ${summary.success ? 'Succeeded' : 'Failed'}`);
  lines.push(`${summary.verdict}`);
  lines.push(
    `Duration: ${summary.totalDurationMs}ms | Steps: ${summary.succeededSteps}/${summary.totalSteps} passed`
  );
  if (!summary.workflowRetrySafe) {
    lines.push('\u26A0 Contains unsafe-to-retry steps');
  }
  lines.push('');

  for (const step of summary.steps) {
    const icon = step.success ? '\u2713' : '\u2717';
    lines.push(`${icon} Step ${step.step}: ${step.description} (${step.durationMs}ms)`);

    if (step.outcomeStatus) {
      lines.push(
        `  Outcome: ${step.outcomeStatus}${step.retrySafe === false ? ' (unsafe to retry)' : ''}`
      );
    }

    if (step.outcomeEvidence) {
      for (const evidence of step.outcomeEvidence) {
        lines.push(`  ${evidence}`);
      }
    }

    if (step.error) {
      lines.push(`  Error: ${step.error}`);
    }
    if (step.suggestion) {
      lines.push(`  \u2192 ${step.suggestion}`);
    }
  }

  return lines.join('\n');
}
