/**
 * Action/Step types for batch execution
 */

import type { FailureHint } from '../browser/types.ts';

export type FailureReason =
  | 'missing'
  | 'hidden'
  | 'covered'
  | 'disabled'
  | 'readonly'
  | 'detached'
  | 'replaced'
  | 'notEditable'
  | 'timeout'
  | 'navigation'
  | 'cdpError'
  | 'unknown';

export type ActionType =
  | 'goto'
  | 'click'
  | 'fill'
  | 'type'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'submit'
  | 'press'
  | 'shortcut'
  | 'focus'
  | 'hover'
  | 'scroll'
  | 'wait'
  | 'snapshot'
  | 'forms'
  | 'screenshot'
  | 'evaluate'
  | 'text'
  | 'newTab'
  | 'closeTab'
  | 'switchFrame'
  | 'switchToMain'
  | 'assertVisible'
  | 'assertExists'
  | 'assertText'
  | 'assertUrl'
  | 'assertValue';

export interface Step {
  /** Action type */
  action: ActionType;

  /** Target selector(s) - array means try each until one works */
  selector?: string | string[];

  /** URL for goto action */
  url?: string;

  /** Value for fill, type, select, evaluate actions */
  value?: string | string[];

  /** Target ID for tab operations */
  targetId?: string;

  /** Key for press action */
  key?: string;

  /** Key combo for shortcut action (e.g. "Control+a", "Meta+Shift+z") */
  combo?: string;

  /** Modifier keys for press action */
  modifiers?: Array<'Control' | 'Shift' | 'Alt' | 'Meta'>;

  /** What to wait for (wait action) */
  waitFor?: 'visible' | 'hidden' | 'attached' | 'detached' | 'navigation' | 'networkIdle';

  /** Step-specific timeout override (ms) */
  timeout?: number;

  /** Should this step's failure be ignored? */
  optional?: boolean;

  /** Submit method */
  method?: 'enter' | 'click' | 'enter+click';

  /** Trigger blur after filling (for React/Vue frameworks) */
  blur?: boolean;

  /** Delay between keystrokes for type action */
  delay?: number;

  /** Wait mode after click/submit: true, false, or 'auto' for submit heuristics */
  waitForNavigation?: boolean | 'auto';

  /** Custom select: trigger selector */
  trigger?: string | string[];

  /** Custom select: option selector */
  option?: string | string[];

  /** Custom select: match type */
  match?: 'text' | 'value' | 'contains';

  /** Scroll coordinates */
  x?: number;
  y?: number;

  /** Scroll direction for page-level scroll */
  direction?: 'up' | 'down' | 'left' | 'right';

  /** Scroll amount in pixels */
  amount?: number;

  /** Screenshot options */
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  fullPage?: boolean;

  /** Expected value for assertion steps (substring match for assertText, exact for assertValue/assertUrl) */
  expect?: string;

  /** Retry count for assertion or action steps (default: 0 = no retry) */
  retry?: number;

  /** Delay between retries in ms (default: 500) */
  retryDelay?: number;
}

export interface BatchOptions {
  /** Default timeout for all steps (ms) */
  timeout?: number;

  /** How to handle failures */
  onFail?: 'stop' | 'continue';
}

export interface StepResult {
  /** Step index */
  index: number;

  /** Action type */
  action: ActionType;

  /** Target selector(s) if provided */
  selector?: string | string[];

  /** Which selector was actually used (if multiple provided) */
  selectorUsed?: string;

  /** Whether the step succeeded */
  success: boolean;

  /** Time taken in ms */
  durationMs: number;

  /** Error message if failed */
  error?: string;

  /** Selectors that failed before success (if multiple provided) */
  failedSelectors?: Array<{ selector: string; reason: string }>;

  /** Result value (for snapshot, screenshot, evaluate) */
  result?: unknown;

  /** Text content (for text action) */
  text?: string;

  /** Failure hints when element not found */
  hints?: FailureHint[];

  /** Structured failure classification */
  failureReason?: FailureReason;

  /** Element covering the target (when failureReason is 'covered') */
  coveringElement?: { tag: string; id?: string; className?: string };

  /** AI-friendly suggestion for what to try next */
  suggestion?: string;
}

export interface BatchResult {
  /** Whether all steps succeeded */
  success: boolean;

  /** Index where execution stopped (if onFail: 'stop') */
  stoppedAtIndex?: number;

  /** Individual step results */
  steps: StepResult[];

  /** Total execution time in ms */
  totalDurationMs: number;
}
