/**
 * Action/Step types for batch execution
 */

import type {
  ActionReceipt,
  DispatchState,
  FailureHint,
  ReadyCondition,
} from '../browser/types.ts';

export type UrlMatchMode = 'exact' | 'origin_path' | 'glob' | 'contains';
export type TextMatchMode = 'exact' | 'contains' | 'regex';

export interface AssertionScope {
  selector?: string | string[];
  /** Landmark tag or role, e.g. `main`, `navigation`, or `dialog`. */
  landmark?: string;
}

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

export type OutcomeStatus = 'success' | 'failed' | 'ambiguous' | 'unsafe_to_retry';

export type ActionEffect = 'observe' | 'idempotent' | 'at_most_once';

export type RetryDecisionReason =
  | 'not_needed_success'
  | 'max_attempts_reached'
  | 'retry_allowed_pre_dispatch'
  | 'dispatch_already_attempted'
  | 'dangerous_dispatched'
  | 'retry_unsafe'
  | 'missing_retry_metadata'
  | 'dangerous_pre_dispatch_not_explicit';

export type Condition =
  | { kind: 'urlMatches'; pattern: string; mode?: UrlMatchMode; match?: UrlMatchMode }
  | { kind: 'elementVisible'; selector: string | string[] }
  | { kind: 'elementHidden'; selector: string | string[] }
  | {
      kind: 'textAppears';
      selector?: string | string[];
      text: string;
      mode?: TextMatchMode;
      match?: TextMatchMode;
      scope?: AssertionScope;
      landmark?: string;
    }
  | {
      kind: 'textChanges';
      selector?: string | string[];
      from?: string;
      to?: string;
      mode?: TextMatchMode;
      match?: TextMatchMode;
      scope?: AssertionScope;
      landmark?: string;
    }
  | { kind: 'networkResponse'; urlPattern: string; status?: number }
  | { kind: 'stateSignatureChanges'; mode?: 'text' | 'structure' }
  | { kind: 'selectedTab'; selector?: string | string[]; name?: string; landmark?: string }
  | { kind: 'fieldValue'; selector: string | string[]; value: string; landmark?: string }
  | { kind: 'checkbox'; selector: string | string[]; checked: boolean; landmark?: string }
  | { kind: 'switch'; selector: string | string[]; checked: boolean; landmark?: string }
  | {
      kind: 'elementEnabled';
      selector: string | string[];
      enabled?: boolean;
      landmark?: string;
    }
  | { kind: 'targetCount'; count: number; type?: string }
  | {
      kind: 'newTarget';
      targetId?: string;
      openerTargetId?: string;
      url?: string;
      type?: string;
    }
  | { kind: 'urlChanged'; from?: string; mode?: UrlMatchMode }
  | {
      kind: 'fieldChanged';
      selector: string | string[];
      from?: string;
      to?: string;
      landmark?: string;
    };

export interface MatchedCondition {
  condition: Condition;
  matched: boolean;
  detail?: string;
}

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
  | 'waitForReady'
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
  | 'assertValue'
  | 'waitForWsMessage'
  | 'assertNoConsoleErrors'
  | 'assertTextChanged'
  | 'assertPermission'
  | 'assertMediaTrackLive'
  | 'delta'
  | 'review'
  | 'chooseOption'
  | 'upload';

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
  waitFor?: 'visible' | 'hidden' | 'attached' | 'detached' | 'navigation' | 'networkIdle' | 'ready';

  /** Correlated navigation lifecycle milestone. */
  waitUntil?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle';

  /** Step-specific timeout override (ms) */
  timeout?: number;

  /** Should this step's failure be ignored? */
  optional?: boolean;

  /** Submit method; enter+click selects one dispatch and never sends both. */
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
  match?: string;

  /** Structured matcher for trace-backed waits */
  where?: Record<string, unknown>;

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

  /** Explicit URL matcher; omitted preserves the legacy contains behavior. */
  urlMode?: UrlMatchMode;
  /** Explicit text matcher; omitted preserves the legacy contains behavior. */
  textMode?: TextMatchMode;
  /** Landmark scope for text/value assertions. */
  landmark?: string;
  /** Optional selector scope for assertion conditions. */
  scope?: AssertionScope;
  /** Expected selected/checked/enabled state for state assertions. */
  checked?: boolean;
  enabled?: boolean;
  /** Exact target count assertion. */
  targetCount?: number;
  /** Capture/verify a transition from the pre-step state. */
  transition?: 'urlChanged' | 'fieldChanged';

  /** Retry count for assertion or action steps (default: 0 = no retry) */
  retry?: number;

  /** Delay between retries in ms (default: 500) */
  retryDelay?: number;

  /** Previous text expected before a change */
  from?: string;

  /** Text expected after a change */
  to?: string;

  /** Permission or resource name */
  name?: string;

  /** Expected permission state */
  state?: string;

  /** Media track kind */
  kind?: 'audio' | 'video';

  /** File paths for upload action */
  files?: string[];

  /** Assertion observation window in milliseconds */
  windowMs?: number;

  /** Conditions where ANY matching means success */
  expectAny?: Condition[];

  /** Conditions where ALL must match for success */
  expectAll?: Condition[];

  /** Conditions that indicate failure (checked before success conditions) */
  failIf?: Condition[];

  /** Mark step as dangerous - never auto-retry after ambiguous outcome */
  dangerous?: boolean;

  /** Semantic readiness conditions for the waitForReady batch action. */
  any?: ReadyCondition[];
  all?: ReadyCondition[];
  loadingHidden?: string | string[];
  predicate?: string;
  stableForMs?: number;
  domQuietForMs?: number;
  pollInterval?: number;

  /** Effect policy used by the centralized retry decision. */
  effect?: ActionEffect;

  /** Natural-language target anchor supplied by a higher-level planner/driver. */
  anchor?: string;
}

export interface RecordOptions {
  /** Base directory for screenshots and recording.json. */
  outputDir?: string;
  /** Session identifier stored in the manifest. CLI fills this automatically. */
  sessionId?: string;
  /** Image format. Default: 'webp' */
  format?: 'png' | 'jpeg' | 'webp';
  /** Image quality 0-100 (webp/jpeg only). Default: 40 */
  quality?: number;
  /** Inject visual highlights before capture. Default: true */
  highlights?: boolean;
  /** Actions to skip capturing. Default: ['wait', 'snapshot', 'forms', 'text', 'screenshot'] */
  skipActions?: ActionType[];
}

export interface BatchOptions {
  /** Default timeout for all steps (ms) */
  timeout?: number;

  /** How to handle failures */
  onFail?: 'stop' | 'continue';

  /** Enable screenshot recording */
  record?: RecordOptions;
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

  /** Effect policy copied from the submitted step for downstream safety artifacts. */
  effect?: ActionEffect;

  /** Natural-language target anchor copied from the submitted step. */
  anchor?: string;

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

  /** Absolute timestamp (ms since epoch) when this step completed */
  timestamp?: number;

  /** Viewport coordinates where the action occurred (center of interacted element) */
  coordinates?: { x: number; y: number };

  /** Element bounding box at time of action (viewport-relative) */
  boundingBox?: { x: number; y: number; width: number; height: number };

  /** Path to screenshot file captured after this step (when recording enabled) */
  screenshotPath?: string;

  /** Outcome classification when conditions were specified */
  outcomeStatus?: OutcomeStatus;

  /** Which conditions matched during evaluation */
  matchedConditions?: MatchedCondition[];

  /** Whether it's safe to retry this step */
  retrySafe?: boolean;

  /** Globally unique action identity for this attempt. */
  actionId?: string;
  /** Execution identity containing this logical step. */
  executionId?: string;
  /** Zero-based attempt number for this logical step. */
  attempt?: number;
  /** Target identity used for this step. */
  targetId?: string;
  /** Target provenance captured when the Page was attached. */
  targetProvenance?: Record<string, unknown>;

  /** Evidence collected by the page about the action dispatch boundary. */
  receipt?: ActionReceipt;
  /** Flattened dispatch state for JSON/summary consumers. */
  dispatchState?: DispatchState;

  /** Number of attempts made for this logical step. */
  attempts?: number;

  /** Why the centralized retry policy did or did not retry. */
  retryDecisionReason?: RetryDecisionReason;
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

  /** Path to recording manifest (when recording is enabled) */
  recordingManifest?: string;
}
