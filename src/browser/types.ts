/**
 * Browser and Page type definitions
 */

import type { WaitState } from '../wait/index.ts';
import type { StaleRecoveryDiagnostics } from './stale-errors.ts';

export type NavigationMilestone = 'commit' | 'domcontentloaded' | 'load' | 'networkidle';

export type ReadyCondition =
  | string
  | {
      selector?: string | string[];
      url?: string;
      predicate?: string | (() => unknown);
    };

export interface WaitForReadyOptions extends ActionOptions {
  /** At least one visible selector/URL/predicate must match. */
  any?: ReadyCondition[];
  /** Every supplied selector/URL/predicate must match. */
  all?: ReadyCondition[];
  /** Selectors that must be hidden or absent before the page is ready. */
  loadingHidden?: string | string[];
  /** URL substring that must match. */
  url?: string;
  /** Predicate expression/function that must return truthy. */
  predicate?: string | (() => unknown);
  /** Require this long without DOM mutations before reporting ready. */
  stableForMs?: number;
  /** Explicit alias for the DOM quiet period. */
  domQuietForMs?: number;
  /** Polling interval in milliseconds. */
  pollInterval?: number;
  /** Internal execution context for frame-local readiness checks. */
  contextId?: number;
}

export interface ReadinessDiagnostics {
  ready: boolean;
  waitedMs: number;
  lastMilestone?: NavigationMilestone;
  unmetConditions: string[];
  checkedAt: string;
}

export type DispatchState = 'not_dispatched' | 'dispatched' | 'uncertain';

/** Evidence about whether a logical action crossed the browser side-effect boundary. */
export interface ActionReceipt {
  dispatchState: DispatchState;
  retrySafe: boolean;
  inputEventsSent: string[];
  navigationObserved?: boolean;
  staleRecovery?: StaleRecoveryDiagnostics;
  /** Execution metadata added by BatchExecutor when the action is recorded. */
  executionId?: string;
  actionId?: string;
  attempt?: number;
  targetId?: string;
}

export interface TargetProvenance {
  targetId: string;
  source?: 'selected' | 'new_page' | 'popup' | 'session';
  type?: string;
  openerTargetId?: string;
  createdAt?: string;
  url?: string;
  title?: string;
}

export interface ExpectNewPageOptions {
  /** Target that must have opened the new page. */
  openerTargetId?: string;
  /** Allowed target type(s), defaulting to `page`. */
  type?: string | string[];
  /** URL substring or regular expression. about:blank remains pending. */
  url?: string | RegExp;
  /** Exact title string or regular expression. Empty titles remain pending. */
  title?: string | RegExp;
  /** Maximum time to wait for creation, navigation, and attachment. */
  timeout?: number;
}

// Action options
export interface ActionOptions {
  /** Timeout in milliseconds */
  timeout?: number;
  /** Don't throw on failure, return false instead */
  optional?: boolean;
  /** Navigation lifecycle milestone to await when this action navigates. */
  waitUntil?: NavigationMilestone;
}

export interface FillOptions extends ActionOptions {
  /** Trigger blur after filling (useful for React/Vue frameworks that update on blur) */
  blur?: boolean;
  /**
   * Verify value stuck after fill; falls back to char-by-char typing if not.
   * - `true` / `"exact"` (default): exact string comparison.
   * - `false`: skip verification entirely.
   * - `"normalized"`: tolerate auto-formatting (e.g. phone/card masks, NBSP
   *   formatters) by comparing with unicode-whitespace collapsed and, failing
   *   that, whitespace stripped entirely. Still case-sensitive; punctuation is
   *   not stripped. The char-by-char fallback only runs if the normalized
   *   comparison also fails, to avoid retyping into a field that merely
   *   reformatted the value.
   */
  verify?: boolean | 'exact' | 'normalized';
}

export interface TypeOptions extends ActionOptions {
  /** Delay between keystrokes in ms */
  delay?: number;
  /** Blur the element after typing */
  blur?: boolean;
}

export interface SubmitOptions extends ActionOptions {
  /**
   * How to submit: 'enter' | 'click' | 'enter+click'. The combined mode
   * selects one dispatch (the trusted click path) and never sends both.
   */
  method?: 'enter' | 'click' | 'enter+click';
  /**
   * Wait for navigation after submit:
   * - 'auto' (default): Race navigation detection vs short delay for client-side forms
   * - true: Always wait for full navigation
   * - false: Return immediately without waiting
   */
  waitForNavigation?: boolean | 'auto';
}

export interface WaitForOptions extends ActionOptions {
  /** State to wait for */
  state?: WaitState;
  /** Polling interval in ms */
  pollInterval?: number;
}

export interface NetworkIdleOptions extends ActionOptions {
  /** Time with no requests before considered idle */
  idleTime?: number;
}

// Select options
export interface CustomSelectConfig {
  /** Selector for the dropdown trigger */
  trigger: string | string[];
  /** Selector pattern for options */
  option: string | string[];
  /** Value to select */
  value: string;
  /** How to match the value */
  match?: 'text' | 'value' | 'contains';
}

// File handling
export interface FileInput {
  /** File name */
  name: string;
  /** MIME type */
  mimeType: string;
  /** File content as base64 or ArrayBuffer */
  buffer: ArrayBuffer | string;
}

export interface Download {
  /** Downloaded file name */
  filename: string;
  /** Path to downloaded file (if available) */
  path?: string;
  /** Get file content as ArrayBuffer */
  content(): Promise<ArrayBuffer>;
}

// Element info
export interface ElementInfo {
  /** Node ID in the DOM */
  nodeId: number;
  /** Backend node ID */
  backendNodeId: number;
  /** Selector that matched */
  selector: string;
  /** Time spent waiting for element */
  waitedMs: number;
}

// Arbitrary-selector DOM state
export interface ElementState {
  /** At least one match in the DOM (shadow roots pierced) */
  exists: boolean;
  /** First match is visibly rendered (display/visibility/opacity + non-zero box) */
  visible: boolean;
  /** Number of matches */
  count: number;
  /** First match's innerText (fallback textContent), trimmed; "" if none */
  text: string;
  /**
   * First match's form-control value: `el.value` for `<input>`/`<select>`/
   * `<textarea>`, otherwise null (including when there is no match).
   */
  value: string | null;
  /** First match's bounding box; null if no match or not rendered */
  boundingBox: { x: number; y: number; width: number; height: number } | null;
}

// Action result
export interface ActionResult {
  /** Whether the action succeeded */
  success: boolean;
  /** Time taken in ms */
  durationMs: number;
  /** Selector used (if multiple provided) */
  selectorUsed?: string;
  /** Selectors that failed (if multiple provided) */
  failedSelectors?: Array<{ selector: string; reason: string }>;
}

// Snapshot types
export interface PageSnapshot {
  /** Current URL */
  url: string;
  /** Page title */
  title: string;
  /** Snapshot timestamp */
  timestamp: string;
  /** Accessibility tree nodes */
  accessibilityTree: SnapshotNode[];
  /** Interactive elements for quick reference */
  interactiveElements: InteractiveElement[];
  /** Text representation of the page */
  text: string;
}

export interface SnapshotOptions {
  /** Restrict the snapshot to these accessibility roles */
  roles?: string[];
  /**
   * Capture real DOM attributes (`id`, `data-testid`/`data-test`/`data-qa`,
   * stable `class`es, `name`, `type`) onto each `InteractiveElement.attributes`
   * via a single batched in-page pass. Opt-in: when `false`/omitted the
   * snapshot is byte-for-byte the cheap accessibility-only result. Default: false.
   */
  attributes?: boolean;
  /**
   * Extra DOM attribute names to capture onto `InteractiveElement.attributes`
   * beyond the built-in set, when `attributes` is enabled. Use this to surface
   * site-specific deterministic hooks (e.g. `data-cmd`) so the selector ranker
   * can turn them into `[attr="value"]` candidates. Ignored when `attributes`
   * is falsy. Default: none.
   */
  attributeNames?: string[];
}

export interface SnapshotNode {
  /** Accessibility role */
  role: string;
  /** Accessible name */
  name?: string;
  /** Current value */
  value?: string;
  /** Element reference (e.g., "e1", "e2") */
  ref: string;
  /** Child nodes */
  children?: SnapshotNode[];
  /** Whether the element is disabled */
  disabled?: boolean;
  /** Whether the element is checked (for checkboxes) */
  checked?: boolean;
  /** Additional properties */
  properties?: Record<string, unknown>;
}

export interface InteractiveElement {
  /** Element reference */
  ref: string;
  /** Accessibility role */
  role: string;
  /** Accessible name */
  name: string;
  /** CSS selector to target this element */
  selector: string;
  /** Whether the element is disabled */
  disabled?: boolean;
  /** Whether the element is checked */
  checked?: boolean;
  /** Current value where relevant */
  value?: string;
  /**
   * Real DOM attributes for this element (data-testid/data-test/data-qa/id/class/name/type).
   * Populated only when `snapshot({ attributes: true })` is passed (Phase 7 Change 3a).
   */
  attributes?: Record<string, string>;
}

export interface FormOption {
  value: string;
  text: string;
  selected: boolean;
  disabled: boolean;
}

export interface FormField {
  tag: string;
  type: string;
  id?: string;
  name?: string;
  value?: string | string[] | null;
  checked?: boolean;
  required: boolean;
  disabled: boolean;
  label?: string;
  placeholder?: string;
  options?: FormOption[];
}

// Failure hint for element not found errors
export interface FailureHint {
  /** Suggested selector */
  selector: string;
  /** Why this might work */
  reason: string;
  /** Confidence level */
  confidence: 'high' | 'medium' | 'low';
  /** Element info */
  element: {
    ref: string;
    role: string;
    name: string;
    disabled?: boolean;
  };
}

// Errors
export class ElementNotFoundError extends Error {
  selectors: string[];
  hints?: FailureHint[];

  constructor(selectors: string | string[], hints?: FailureHint[]) {
    const selectorList = Array.isArray(selectors) ? selectors : [selectors];
    let msg = `Element not found: ${selectorList.join(', ')}`;
    if (hints?.length) {
      msg += `. Did you mean: ${hints
        .slice(0, 3)
        .map((h) => `${h.element.ref} (${h.element.role} "${h.element.name}")`)
        .join(', ')}`;
    }
    msg += `. Run 'bp snapshot' to see available elements.`;
    super(msg);
    this.name = 'ElementNotFoundError';
    this.selectors = selectorList;
    this.hints = hints;
  }
}

export class TimeoutError extends Error {
  constructor(message = 'Operation timed out') {
    const msg = message.includes('bp snapshot')
      ? message
      : `${message}. Run 'bp snapshot' to check current page state.`;
    super(msg);
    this.name = 'TimeoutError';
  }
}

export class NavigationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NavigationError';
  }
}

/** Raised when an effectful browser dispatch may have reached Chrome. */
export class ActionDispatchUncertainError extends Error {
  readonly receipt: ActionReceipt;

  constructor(receipt: ActionReceipt, message = 'Browser action dispatch is uncertain.') {
    super(`${message} Verify the postcondition before another action.`);
    this.name = 'ActionDispatchUncertainError';
    this.receipt = receipt;
  }
}

export interface TargetSummary {
  targetId: string;
  url: string;
  title?: string;
}

export interface TargetNotFoundDetails {
  targetId?: string;
  targetUrl?: string;
  availableTargets?: TargetSummary[];
  reason?: string;
}

/**
 * Raised when an explicitly requested browser target cannot be selected.
 *
 * Target selection is intentionally fail-closed: attaching to a different tab
 * can be a much more dangerous failure than not attaching at all. The
 * available-target list is metadata only and deliberately excludes page
 * contents.
 */
export class TargetNotFoundError extends Error {
  readonly targetId?: string;
  readonly targetUrl?: string;
  readonly availableTargets: TargetSummary[];

  constructor(details: TargetNotFoundDetails = {}) {
    const constraints: string[] = [];
    if (details.targetId !== undefined)
      constraints.push(`targetId=${JSON.stringify(details.targetId)}`);
    if (details.targetUrl !== undefined)
      constraints.push(`targetUrl=${JSON.stringify(details.targetUrl)}`);
    const requested = constraints.length > 0 ? constraints.join(', ') : 'explicit target';
    const available = (details.availableTargets ?? []).map((target) => ({
      targetId: target.targetId,
      // Query strings and fragments may contain credentials or page state.
      url: redactTargetUrl(target.url),
    }));
    const suffix = details.reason ? ` ${details.reason}` : '';
    super(
      `Could not find requested ${requested}.${suffix} ` +
        `Available page targets: ${available.length > 0 ? JSON.stringify(available) : 'none'}.`
    );
    this.name = 'TargetNotFoundError';
    this.targetId = details.targetId;
    this.targetUrl = details.targetUrl;
    this.availableTargets = available;
  }
}

function redactTargetUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url.split(/[?#]/, 1)[0] ?? url;
  }
}

// ============ Emulation Types ============

export interface ViewportOptions {
  /** Viewport width in pixels */
  width: number;
  /** Viewport height in pixels */
  height: number;
  /** Device scale factor (default: 1) */
  deviceScaleFactor?: number;
  /** Whether to emulate mobile (default: false) */
  isMobile?: boolean;
  /** Whether the meta viewport tag should be accounted for (default: false) */
  hasTouch?: boolean;
  /** Whether to emulate landscape orientation (default: false) */
  isLandscape?: boolean;
}

export interface GeolocationOptions {
  /** Latitude in degrees */
  latitude: number;
  /** Longitude in degrees */
  longitude: number;
  /** Accuracy in meters (default: 1) */
  accuracy?: number;
}

export interface UserAgentOptions {
  /** User agent string */
  userAgent: string;
  /** Accept-Language header value */
  acceptLanguage?: string;
  /** Platform override (e.g., "Win32", "MacIntel") */
  platform?: string;
  /** User agent metadata for Client Hints */
  userAgentMetadata?: UserAgentMetadata;
}

export interface UserAgentMetadata {
  brands?: Array<{ brand: string; version: string }>;
  fullVersionList?: Array<{ brand: string; version: string }>;
  fullVersion?: string;
  platform?: string;
  platformVersion?: string;
  architecture?: string;
  model?: string;
  mobile?: boolean;
  bitness?: string;
  wow64?: boolean;
}

export interface EmulationState {
  viewport?: ViewportOptions;
  userAgent?: UserAgentOptions;
  geolocation?: GeolocationOptions;
  timezone?: string;
  locale?: string;
}

// ============ Console & Dialog Types ============

export type ConsoleMessageType =
  | 'log'
  | 'debug'
  | 'info'
  | 'error'
  | 'warning'
  | 'dir'
  | 'dirxml'
  | 'table'
  | 'trace'
  | 'clear'
  | 'startGroup'
  | 'startGroupCollapsed'
  | 'endGroup'
  | 'assert'
  | 'profile'
  | 'profileEnd'
  | 'count'
  | 'timeEnd';

export interface ConsoleMessage {
  /** Message type */
  type: ConsoleMessageType;
  /** Message text */
  text: string;
  /** Arguments passed to console method */
  args: unknown[];
  /** Source URL */
  url?: string;
  /** Line number */
  lineNumber?: number;
  /** Column number */
  columnNumber?: number;
  /** Stack trace if available */
  stackTrace?: string[];
  /** Timestamp */
  timestamp: number;
}

export interface PageError {
  /** Error message */
  message: string;
  /** Source URL */
  url?: string;
  /** Line number */
  lineNumber?: number;
  /** Column number */
  columnNumber?: number;
  /** Stack trace */
  stackTrace?: string[];
  /** Timestamp */
  timestamp: number;
}

export type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload';

export interface Dialog {
  /** Dialog type */
  type: DialogType;
  /** Dialog message */
  message: string;
  /** Default value for prompt dialogs */
  defaultValue?: string;
  /** Accept the dialog (click OK) */
  accept(promptText?: string): Promise<void>;
  /** Dismiss the dialog (click Cancel) */
  dismiss(): Promise<void>;
}

export type ConsoleHandler = (message: ConsoleMessage) => void;
export type ErrorHandler = (error: PageError) => void;
export type DialogHandler = (dialog: Dialog) => void | Promise<void>;
