/**
 * Consumer type test: Batch/action usage
 *
 * Verifies batch execution types work for downstream consumers.
 */
import type { ActionType, BatchOptions, BatchResult, Step, StepResult } from '../../src/index.ts';

// Verify Step type accepts various actions
const steps: Step[] = [
  { action: 'goto', url: 'https://example.com' },
  { action: 'click', selector: '#btn' },
  { action: 'fill', selector: '#input', value: 'hello' },
  { action: 'wait', timeout: 1000 },
  { action: 'snapshot' },
  { action: 'assertVisible', selector: '.result' },
  { action: 'assertText', expect: 'Success' },
];
void steps;

// Verify BatchOptions
const opts: BatchOptions = { onFail: 'stop', timeout: 30000 };
void opts;

// Verify result types
declare const result: BatchResult;
const _success: boolean = result.success;
void _success;

declare const stepResult: StepResult;
const _action: ActionType = stepResult.action;
void _action;
