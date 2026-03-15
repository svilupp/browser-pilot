import { describe, expect, test } from 'bun:test';
import type { BatchResult, StepResult } from '../../src/actions/types.ts';
import { buildWorkflowSummary, formatWorkflowSummary } from '../../src/trace/workflow-summary.ts';

function makeStepResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    index: 0,
    action: 'click',
    success: true,
    durationMs: 100,
    ...overrides,
  };
}

function makeBatchResult(overrides: Partial<BatchResult> = {}): BatchResult {
  return {
    success: true,
    steps: [makeStepResult()],
    totalDurationMs: 100,
    ...overrides,
  };
}

describe('buildWorkflowSummary', () => {
  test('all-success batch result', () => {
    const batch = makeBatchResult({
      steps: [
        makeStepResult({ index: 0, action: 'goto', durationMs: 50 }),
        makeStepResult({ index: 1, action: 'click', selector: '#btn', durationMs: 30 }),
        makeStepResult({ index: 2, action: 'fill', selector: '#email', durationMs: 20 }),
      ],
      totalDurationMs: 100,
    });

    const summary = buildWorkflowSummary(batch);

    expect(summary.success).toBe(true);
    expect(summary.totalSteps).toBe(3);
    expect(summary.succeededSteps).toBe(3);
    expect(summary.failedSteps).toBe(0);
    expect(summary.totalDurationMs).toBe(100);
    expect(summary.workflowRetrySafe).toBe(true);
    expect(summary.verdict).toContain('successfully');
    expect(summary.verdict).toContain('3/3');
    expect(summary.steps).toHaveLength(3);
    expect(summary.steps[0]!.step).toBe(1);
    expect(summary.steps[1]!.step).toBe(2);
    expect(summary.steps[2]!.step).toBe(3);
  });

  test('failed step', () => {
    const batch = makeBatchResult({
      success: false,
      steps: [
        makeStepResult({ index: 0, action: 'goto', durationMs: 50 }),
        makeStepResult({
          index: 1,
          action: 'click',
          selector: '#missing',
          success: false,
          durationMs: 30,
          error: 'Element not found',
          suggestion: 'Try a different selector',
        }),
      ],
      totalDurationMs: 80,
    });

    const summary = buildWorkflowSummary(batch);

    expect(summary.success).toBe(false);
    expect(summary.succeededSteps).toBe(1);
    expect(summary.failedSteps).toBe(1);
    expect(summary.steps[1]!.error).toBe('Element not found');
    expect(summary.steps[1]!.suggestion).toBe('Try a different selector');
    expect(summary.verdict).toContain('1 failure');
  });

  test('outcome conditions (matched and unmatched)', () => {
    const batch = makeBatchResult({
      steps: [
        makeStepResult({
          index: 0,
          action: 'click',
          selector: '#submit',
          outcomeStatus: 'success',
          retrySafe: true,
          matchedConditions: [
            {
              condition: { kind: 'urlMatches', pattern: '/dashboard' },
              matched: true,
              detail: 'URL matches /dashboard',
            },
            {
              condition: { kind: 'elementVisible', selector: '.welcome' },
              matched: false,
              detail: 'Element .welcome visible',
            },
          ],
        }),
      ],
    });

    const summary = buildWorkflowSummary(batch);

    expect(summary.steps[0]!.outcomeStatus).toBe('success');
    expect(summary.steps[0]!.retrySafe).toBe(true);
    expect(summary.steps[0]!.outcomeEvidence).toHaveLength(2);
    expect(summary.steps[0]!.outcomeEvidence![0]).toContain('\u2713');
    expect(summary.steps[0]!.outcomeEvidence![0]).toContain('URL matches /dashboard');
    expect(summary.steps[0]!.outcomeEvidence![1]).toContain('\u2717');
  });

  test('stoppedAtIndex', () => {
    const batch = makeBatchResult({
      success: false,
      stoppedAtIndex: 1,
      steps: [
        makeStepResult({ index: 0, action: 'goto', durationMs: 50 }),
        makeStepResult({
          index: 1,
          action: 'fill',
          selector: '#name',
          success: false,
          durationMs: 30,
          error: 'Element not found',
        }),
      ],
      totalDurationMs: 80,
    });

    const summary = buildWorkflowSummary(batch);

    expect(summary.verdict).toContain('stopped at step 2');
    expect(summary.verdict).toContain('Fill');
  });

  test('stoppedAtIndex with outcomeStatus', () => {
    const batch = makeBatchResult({
      success: false,
      stoppedAtIndex: 0,
      steps: [
        makeStepResult({
          index: 0,
          action: 'click',
          selector: '#pay',
          success: false,
          durationMs: 100,
          outcomeStatus: 'ambiguous',
        }),
      ],
      totalDurationMs: 100,
    });

    const summary = buildWorkflowSummary(batch);

    expect(summary.verdict).toContain('outcome: ambiguous');
  });

  test('unsafe_to_retry step makes workflowRetrySafe false', () => {
    const batch = makeBatchResult({
      steps: [
        makeStepResult({
          index: 0,
          action: 'click',
          selector: '#pay',
          outcomeStatus: 'unsafe_to_retry',
          retrySafe: false,
        }),
      ],
    });

    const summary = buildWorkflowSummary(batch);

    expect(summary.workflowRetrySafe).toBe(false);
  });

  test('retrySafe false without outcomeStatus also makes workflow unsafe', () => {
    const batch = makeBatchResult({
      steps: [
        makeStepResult({ index: 0, action: 'click', outcomeStatus: 'failed', retrySafe: false }),
      ],
    });

    const summary = buildWorkflowSummary(batch);

    expect(summary.workflowRetrySafe).toBe(false);
  });

  test('empty steps array', () => {
    const batch = makeBatchResult({ steps: [], totalDurationMs: 0 });

    const summary = buildWorkflowSummary(batch);

    expect(summary.totalSteps).toBe(0);
    expect(summary.succeededSteps).toBe(0);
    expect(summary.failedSteps).toBe(0);
    expect(summary.steps).toHaveLength(0);
    expect(summary.workflowRetrySafe).toBe(true);
    expect(summary.verdict).toContain('successfully');
  });
});

describe('formatWorkflowSummary', () => {
  test('produces readable text for success', () => {
    const summary = buildWorkflowSummary(
      makeBatchResult({
        steps: [
          makeStepResult({ index: 0, action: 'goto', durationMs: 50 }),
          makeStepResult({ index: 1, action: 'click', selector: '#btn', durationMs: 30 }),
        ],
        totalDurationMs: 80,
      })
    );

    const text = formatWorkflowSummary(summary);

    expect(text).toContain('## Workflow Succeeded');
    expect(text).toContain('Duration: 80ms');
    expect(text).toContain('2/2 passed');
    expect(text).toContain('\u2713 Step 1: Navigate to page');
    expect(text).toContain('\u2713 Step 2: Click "#btn"');
  });

  test('produces readable text for failure', () => {
    const summary = buildWorkflowSummary(
      makeBatchResult({
        success: false,
        steps: [
          makeStepResult({ index: 0, action: 'goto', durationMs: 50 }),
          makeStepResult({
            index: 1,
            action: 'click',
            selector: '#btn',
            success: false,
            durationMs: 30,
            error: 'Element not found',
            suggestion: 'Try #submit instead',
          }),
        ],
        totalDurationMs: 80,
      })
    );

    const text = formatWorkflowSummary(summary);

    expect(text).toContain('## Workflow Failed');
    expect(text).toContain('\u2717 Step 2');
    expect(text).toContain('Error: Element not found');
    expect(text).toContain('\u2192 Try #submit instead');
  });

  test('includes unsafe-to-retry warning', () => {
    const summary = buildWorkflowSummary(
      makeBatchResult({
        steps: [
          makeStepResult({
            index: 0,
            action: 'click',
            outcomeStatus: 'unsafe_to_retry',
            retrySafe: false,
          }),
        ],
      })
    );

    const text = formatWorkflowSummary(summary);

    expect(text).toContain('\u26A0 Contains unsafe-to-retry steps');
    expect(text).toContain('Outcome: unsafe_to_retry (unsafe to retry)');
  });

  test('includes outcome evidence', () => {
    const summary = buildWorkflowSummary(
      makeBatchResult({
        steps: [
          makeStepResult({
            index: 0,
            action: 'click',
            outcomeStatus: 'success',
            matchedConditions: [
              {
                condition: { kind: 'urlMatches', pattern: '/ok' },
                matched: true,
                detail: 'URL changed to /ok',
              },
            ],
          }),
        ],
      })
    );

    const text = formatWorkflowSummary(summary);

    expect(text).toContain('Outcome: success');
    expect(text).toContain('\u2713 URL changed to /ok');
  });
});

describe('describeStep', () => {
  test('generates descriptions for all common action types', () => {
    const actions: Array<{ action: StepResult['action']; selector?: string; expected: string }> = [
      { action: 'goto', expected: 'Navigate to page' },
      { action: 'click', selector: '#btn', expected: 'Click "#btn"' },
      { action: 'click', expected: 'Click element' },
      { action: 'fill', selector: '#email', expected: 'Fill "#email"' },
      { action: 'type', selector: '#input', expected: 'Type into "#input"' },
      { action: 'select', selector: '#dropdown', expected: 'Select option in "#dropdown"' },
      { action: 'submit', expected: 'Submit form' },
      { action: 'check', selector: '#agree', expected: 'Check "#agree"' },
      { action: 'uncheck', selector: '#opt', expected: 'Uncheck "#opt"' },
      { action: 'press', expected: 'Press key' },
      { action: 'shortcut', expected: 'Keyboard shortcut' },
      { action: 'hover', selector: '.menu', expected: 'Hover over ".menu"' },
      { action: 'scroll', expected: 'Scroll page' },
      { action: 'wait', selector: '#loader', expected: 'Wait for "#loader"' },
      { action: 'snapshot', expected: 'Capture accessibility snapshot' },
      { action: 'screenshot', expected: 'Take screenshot' },
      { action: 'forms', expected: 'Enumerate form fields' },
      { action: 'evaluate', expected: 'Execute JavaScript' },
      { action: 'text', expected: 'Extract text content' },
      { action: 'review', expected: 'Extract page review' },
      { action: 'delta', expected: 'Capture page delta' },
    ];

    for (const { action, selector, expected } of actions) {
      const summary = buildWorkflowSummary(
        makeBatchResult({
          steps: [makeStepResult({ index: 0, action, selector })],
        })
      );
      expect(summary.steps[0]!.description).toBe(expected);
    }
  });

  test('uses selectorUsed when available', () => {
    const summary = buildWorkflowSummary(
      makeBatchResult({
        steps: [
          makeStepResult({
            index: 0,
            action: 'click',
            selector: ['#a', '#b'],
            selectorUsed: '#b',
          }),
        ],
      })
    );

    expect(summary.steps[0]!.description).toBe('Click "#b"');
  });

  test('uses first selector from array when selectorUsed not set', () => {
    const summary = buildWorkflowSummary(
      makeBatchResult({
        steps: [
          makeStepResult({
            index: 0,
            action: 'click',
            selector: ['#a', '#b'],
          }),
        ],
      })
    );

    expect(summary.steps[0]!.description).toBe('Click "#a"');
  });

  test('handles unknown action types via default branch', () => {
    const summary = buildWorkflowSummary(
      makeBatchResult({
        steps: [
          makeStepResult({
            index: 0,
            action: 'newTab' as StepResult['action'],
          }),
        ],
      })
    );

    expect(summary.steps[0]!.description).toBe('newTab');
  });

  test('handles unknown action types with selector via default branch', () => {
    const summary = buildWorkflowSummary(
      makeBatchResult({
        steps: [
          makeStepResult({
            index: 0,
            action: 'switchFrame' as StepResult['action'],
            selector: '#frame1',
          }),
        ],
      })
    );

    expect(summary.steps[0]!.description).toBe('switchFrame "#frame1"');
  });
});
