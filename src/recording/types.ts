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
 */
export type SelectorQuality = 'stable-attr' | 'id' | 'css-path';

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

// Re-export Step for convenience
export type { Step };
