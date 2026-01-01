/**
 * Action/Step types for batch execution
 */

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
  | 'focus'
  | 'hover'
  | 'scroll'
  | 'wait'
  | 'snapshot'
  | 'screenshot'
  | 'evaluate'
  | 'switchFrame'
  | 'switchToMain';

export interface Step {
  /** Action type */
  action: ActionType;

  /** Target selector(s) - array means try each until one works */
  selector?: string | string[];

  /** URL for goto action */
  url?: string;

  /** Value for fill, type, select, evaluate actions */
  value?: string | string[];

  /** Key for press action */
  key?: string;

  /** What to wait for (wait action) */
  waitFor?: 'visible' | 'hidden' | 'attached' | 'detached' | 'navigation' | 'networkIdle';

  /** Step-specific timeout override (ms) */
  timeout?: number;

  /** Should this step's failure be ignored? */
  optional?: boolean;

  /** Submit method */
  method?: 'enter' | 'click' | 'enter+click';

  /** Clear input before filling */
  clear?: boolean;

  /** Delay between keystrokes for type action */
  delay?: number;

  /** Wait for navigation after click action completes */
  waitForNavigation?: boolean;

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
