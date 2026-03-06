/**
 * Recording types for browser action capture
 *
 * These types define the structures used to capture, process, and output
 * recorded browser interactions. Raw events are captured from the browser
 * and then aggregated into Step[] for replay via page.batch().
 */

import type { Step } from '../actions/types.ts';

/**
 * Quality indicator for selector reliability.
 * Used to order selectors from most stable to least stable.
 * Order: role-name > text > aria-label > testid > stable-attr > id > css-path
 */
export type SelectorQuality =
  | 'role-name'
  | 'text'
  | 'aria-label'
  | 'testid'
  | 'stable-attr'
  | 'id'
  | 'name-attr'
  | 'css-path';

/**
 * Selector strategy type for RichRecordedEvent.
 */
export type SelectorStrategy = SelectorQuality;

/**
 * A selector candidate with quality indicator for ordering.
 * Multiple candidates are generated for each element to provide
 * fallback options during replay.
 */
export interface SelectorCandidate {
  /** The CSS selector string */
  selector: string;
  /** Quality indicator for prioritization */
  quality: SelectorQuality;
}

/**
 * Element metadata captured for debugging and manual review.
 * Provides context about the interacted element without being
 * part of the replay logic.
 */
export interface ElementSummary {
  /** HTML tag name (lowercase) */
  tag: string;
  /** Element ID attribute, if present */
  id: string | null;
  /** Element name attribute, if present */
  name: string | null;
  /** Input type attribute, if present */
  type: string | null;
  /** ARIA role attribute, if present */
  role: string | null;
  /** ARIA label attribute, if present */
  ariaLabel: string | null;
  /** data-testid attribute, if present */
  testid: string | null;
  /** First 120 chars of innerText, for identification */
  text: string | null;
  /** Computed accessible name (W3C AccName spec) */
  accessibleName?: string | null;
  /** Computed ARIA role (explicit or implicit from tag) */
  computedRole?: string | null;
}

/**
 * Rich element information for recipe generation.
 * Contains all data needed to identify and describe an element.
 */
export interface ElementInfo {
  /** Computed ARIA role (explicit or implicit) */
  role: string | null;
  /** Computed accessible name */
  name: string | null;
  /** HTML tag name (lowercase) */
  tag: string;
  /** Element ID attribute */
  id: string | null;
  /** data-testid attribute */
  testid: string | null;
  /** aria-label attribute */
  ariaLabel: string | null;
  /** name attribute (for forms) */
  nameAttr: string | null;
  /** input type attribute */
  type: string | null;
  /** CSS classes (for debugging only) */
  classes: string[];
  /** First 200 chars of visible text */
  innerText: string | null;
  /** Input placeholder */
  placeholder: string | null;
  /** Current value (redacted for passwords) */
  value: string | null;
}

/**
 * Context about where the element is located on the page.
 */
export interface ElementContext {
  /** Role of parent container (menu, dialog, listbox) */
  parentRole: string | null;
  /** Name of parent container */
  parentName: string | null;
  /** Landmark region (navigation, main, complementary) */
  landmark: string | null;
  /** Nearest heading text */
  sectionHeading: string | null;
  /** Dialog name if inside modal */
  inDialog: string | null;
  /** Menu name if inside dropdown */
  inMenu: string | null;
  /** Form name/id if inside form */
  inForm: string | null;
  /** Path for debugging: ['Page', 'Payment section', 'Menu'] */
  breadcrumb: string[];
}

/**
 * Visual position of the element.
 */
export interface ElementPosition {
  /** Viewport region */
  viewport: 'header' | 'main' | 'sidebar' | 'footer' | 'modal' | 'unknown';
  /** Bounding box */
  boundingBox: { x: number; y: number; width: number; height: number };
  /** Where user clicked */
  clickPoint: { x: number; y: number };
}

/**
 * Page state when action occurred.
 */
export interface PageState {
  /** Full URL */
  url: string;
  /** Parameterized URL pattern: /orders/{id} */
  urlPattern: string;
  /** Page title */
  title: string;
  /** Unix timestamp */
  timestamp: number;
}

/**
 * What changed after the action.
 */
export interface StateChange {
  /** Did action trigger navigation */
  triggeredNavigation: boolean;
  /** New URL after navigation */
  newUrl: string | null;
  /** Modal that appeared */
  openedDialog: string | null;
  /** Modal that closed */
  closedDialog: string | null;
  /** Dropdown opened */
  openedMenu: boolean;
  /** Dropdown closed */
  closedMenu: boolean;
  /** Value before action (for fill/select) */
  beforeValue: string | null;
  /** Value after action */
  afterValue: string | null;
  /** Inferred wait condition */
  suggestedWait: 'navigation' | 'networkidle' | 'dialog' | null;
}

/**
 * Rich selector candidate with strategy and confidence.
 */
export interface RichSelectorCandidate {
  /** The actual selector */
  value: string;
  /** Selector strategy */
  strategy: SelectorStrategy;
  /** Confidence level */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Rich recorded event with full context for recipe generation.
 */
export interface RichRecordedEvent {
  /** Action type */
  kind: RecordedEventKind;
  /** All selector candidates (try in order) */
  selectors: RichSelectorCandidate[];
  /** Rich element data */
  element: ElementInfo;
  /** Context about location on page */
  context: ElementContext;
  /** Visual position */
  position: ElementPosition;
  /** Page state when action occurred */
  page: PageState;
  /** What changed after action */
  stateChange: StateChange;
  /** Human readable description */
  annotation: string;
}

/**
 * Rich step extending Step with element metadata.
 */
export interface RichStep extends Step {
  /** Element metadata for recipe generation */
  element?: {
    role?: string | null;
    name?: string | null;
    tag?: string;
  };
  /** Human readable description */
  annotation?: string;
}

/**
 * Rich recording output with both full events and simplified steps.
 */
export interface RichRecordingOutput {
  /** ISO timestamp when recording started */
  recordedAt: string;
  /** URL when recording started */
  startUrl: string;
  /** Total recording duration in milliseconds */
  duration: number;
  /** Full event log for recipe generation */
  events: RichRecordedEvent[];
  /** Simplified steps for replay (compatible with page.batch()) */
  steps: RichStep[];
}

/**
 * Kind of recorded event from the browser.
 */
export type RecordedEventKind =
  | 'click'
  | 'dblclick'
  | 'input'
  | 'change'
  | 'keydown'
  | 'submit'
  | 'navigation';

/**
 * Raw event captured from the browser before aggregation.
 * These events are processed by the aggregator to produce Step[] output.
 */
export interface RawRecordedEvent {
  /** Type of event */
  kind: RecordedEventKind;
  /** Unix timestamp when event occurred */
  timestamp: number;
  /** Page URL where event occurred */
  url: string;
  /** Element metadata, if available */
  element?: ElementSummary;
  /** Selector candidates ordered by quality */
  selectors: SelectorCandidate[];
  /** Input value (redacted for password fields) */
  value?: string;
  /** Key pressed (for keydown events) */
  key?: string;
  /** Click coordinates relative to viewport */
  client?: { x: number; y: number };
  /** Whether this was a checked state (for checkboxes) */
  checked?: boolean;
}

/**
 * Final output format from recording.
 * Compatible with page.batch() for replay via bp exec.
 */
export interface RecordingOutput {
  /** ISO timestamp when recording started */
  recordedAt: string;
  /** URL when recording started */
  startUrl: string;
  /** Total recording duration in milliseconds */
  duration: number;
  /** Aggregated steps for replay */
  steps: Step[];
}

// --- Network recording types ---

/** A captured HTTP request. */
export interface RecordedNetworkRequest {
  requestId: string;
  timestamp: number;
  elapsedMs: number;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/** A captured HTTP response. */
export interface RecordedNetworkResponse {
  requestId: string;
  timestamp: number;
  elapsedMs: number;
  status: number;
  headers?: Record<string, string>;
  mimeType?: string;
  body?: string;
  bodySize?: number;
}

/** A captured WebSocket frame (sent or received). */
export interface RecordedWebSocketFrame {
  requestId: string;
  timestamp: number;
  elapsedMs: number;
  direction: 'sent' | 'received';
  opcode: number;
  payload: string;
  length: number;
}

/** A WebSocket lifecycle event. */
export interface RecordedWebSocketEvent {
  requestId: string;
  timestamp: number;
  elapsedMs: number;
  type: 'created' | 'closed' | 'error';
  url?: string;
}

/** A unified timeline entry covering both actions and network events. */
export interface TimelineEntry {
  timestamp: number;
  elapsedMs: number;
  type: 'action' | 'network-request' | 'network-response' | 'ws-frame' | 'ws-event';
  data: unknown;
}

/** Grouped HTTP network events. */
export interface NetworkRecording {
  requests: RecordedNetworkRequest[];
  responses: RecordedNetworkResponse[];
}

/** Grouped WebSocket events. */
export interface WebSocketRecording {
  events: RecordedWebSocketEvent[];
  frames: RecordedWebSocketFrame[];
}

/** Extended recording output that includes network capture data. */
export interface FullRecordingOutput extends RecordingOutput {
  network?: NetworkRecording;
  websockets?: WebSocketRecording;
  timeline?: TimelineEntry[];
}

// Re-export Step for convenience
export type { Step };
