/**
 * Browser and Page type definitions
 */

import type { WaitState } from '../wait/index.ts';

// Action options
export interface ActionOptions {
  /** Timeout in milliseconds */
  timeout?: number;
  /** Don't throw on failure, return false instead */
  optional?: boolean;
}

export interface FillOptions extends ActionOptions {
  /** Clear existing content before filling */
  clear?: boolean;
  /** Trigger blur after filling (useful for React/Vue frameworks that update on blur) */
  blur?: boolean;
}

export interface TypeOptions extends ActionOptions {
  /** Delay between keystrokes in ms */
  delay?: number;
}

export interface SubmitOptions extends ActionOptions {
  /** How to submit: 'enter' | 'click' | 'enter+click' */
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
}

// Errors
export class ElementNotFoundError extends Error {
  selectors: string[];

  constructor(selectors: string | string[]) {
    const selectorList = Array.isArray(selectors) ? selectors : [selectors];
    super(`Element not found: ${selectorList.join(', ')}`);
    this.name = 'ElementNotFoundError';
    this.selectors = selectorList;
  }
}

export class TimeoutError extends Error {
  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class NavigationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NavigationError';
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
