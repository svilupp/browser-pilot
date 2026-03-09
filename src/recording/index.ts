/**
 * Recording module for browser action capture
 *
 * This module provides functionality to record human browser interactions
 * and output them as JSON steps compatible with page.batch() for replay.
 */

// Export aggregator functions
export {
  aggregateEvents,
  debounceInputEvents,
  generateAnnotation,
  selectBestSelectors,
} from './aggregator.ts';
// Export recording manifest types
export type { RecordingFrame, RecordingManifest } from './manifest.ts';
export type { ListenMode, RecorderListenOptions, RecorderOptions } from './recorder.ts';
// Export Recorder class and options
export { Recorder } from './recorder.ts';
// Export recorder script
export { RECORDER_BINDING_NAME, RECORDER_SCRIPT } from './script.ts';

// Export types
export type {
  ElementContext,
  ElementInfo,
  ElementPosition,
  ElementSummary,
  FullRecordingOutput,
  NetworkRecording,
  PageState,
  RawRecordedEvent,
  RecordedEventKind,
  RecordedNetworkRequest,
  RecordedNetworkResponse,
  RecordedWebSocketEvent,
  RecordedWebSocketFrame,
  RecordingOutput,
  RichRecordedEvent,
  RichRecordingOutput,
  RichSelectorCandidate,
  RichStep,
  SelectorCandidate,
  SelectorQuality,
  SelectorStrategy,
  StateChange,
  Step,
  TimelineEntry,
  WebSocketRecording,
} from './types.ts';
