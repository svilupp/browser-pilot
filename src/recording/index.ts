/**
 * Recording module for browser action capture
 *
 * This module provides functionality to record human browser interactions
 * and output them as JSON steps compatible with page.batch() for replay.
 */

// Export aggregator functions
export { aggregateEvents, debounceInputEvents, selectBestSelectors } from './aggregator.ts';

// Export Recorder class
export { Recorder } from './recorder.ts';

// Export recorder script
export { RECORDER_BINDING_NAME, RECORDER_SCRIPT } from './script.ts';

// Export types
export type {
  ElementSummary,
  RawRecordedEvent,
  RecordedEventKind,
  RecordingOutput,
  SelectorCandidate,
  SelectorQuality,
  Step,
} from './types.ts';
