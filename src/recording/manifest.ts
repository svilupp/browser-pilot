/**
 * Recording manifest types and generation
 *
 * Defines the schema for recording.json manifest files that link
 * screenshot frames with metadata for downstream video assembly.
 */

import type { ActionType } from '../actions/types.ts';

export interface RecordingManifest {
  /** Schema version for forward compatibility */
  version: 1;

  /** ISO timestamp when recording started */
  recordedAt: string;

  /** CLI session ID, or page target ID when recorded outside the CLI */
  sessionId: string;

  /** Starting URL */
  startUrl: string;

  /** Ending URL */
  endUrl: string;

  /** Viewport dimensions (consistent across all frames) */
  viewport: { width: number; height: number };

  /** Screenshot format used */
  format: 'png' | 'jpeg' | 'webp';

  /** Quality setting used */
  quality: number;

  /** Total execution time (ms) */
  totalDurationMs: number;

  /** Whether all steps succeeded */
  success: boolean;

  /** Ordered list of captured frames */
  frames: RecordingFrame[];
}

export interface RecordingFrame {
  /** Sequential frame number (1-based, matches filename prefix) */
  seq: number;

  /** Absolute timestamp in ms since epoch */
  timestamp: number;

  /** Action type */
  action: ActionType;

  /** Which selector was used */
  selector?: string;

  /** Value entered/selected (redacted for sensitive fields) */
  value?: string;

  /** URL (for goto actions) */
  url?: string;

  /** Viewport coordinates of action point */
  coordinates?: { x: number; y: number };

  /** Element bounding box */
  boundingBox?: { x: number; y: number; width: number; height: number };

  /** Whether the step succeeded */
  success: boolean;

  /** Step duration (ms) */
  durationMs: number;

  /** Error message if failed */
  error?: string;

  /** Screenshot filename (relative to manifest directory) */
  screenshot: string;

  /** Page URL at time of capture */
  pageUrl?: string;

  /** Page title at time of capture */
  pageTitle?: string;
}
