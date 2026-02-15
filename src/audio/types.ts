/**
 * Audio I/O type definitions
 */

/** A chunk of captured audio data */
export interface AudioChunk {
  /** Left channel PCM data (Float32) */
  left: Float32Array;
  /** Right channel PCM data (Float32) */
  right: Float32Array;
  /** Sample rate */
  sampleRate: number;
  /** Number of samples in this chunk */
  samples: number;
  /** Timestamp when this chunk was received */
  timestamp: number;
}

/** Result of an audio capture session */
export interface CaptureResult {
  /** All captured PCM data, left channel */
  left: Float32Array;
  /** All captured PCM data, right channel */
  right: Float32Array;
  /** Sample rate */
  sampleRate: number;
  /** Total duration in milliseconds */
  durationMs: number;
  /** Number of chunks received */
  chunkCount: number;
}

/** Options for audio output capture */
export interface CaptureOptions {
  /** Stop after N ms of silence (RMS below threshold). Default: 1500 */
  silenceTimeout?: number;
  /** RMS threshold to consider as silence. Default: 0.01 */
  silenceThreshold?: number;
  /** Maximum capture duration in ms. Default: 300000 (5 min) */
  maxDuration?: number;
  /** Stop early if no non-silent audio arrives within this many ms. Default: 15000 */
  noAudioTimeout?: number;
}

/** Options for audio input playback */
export interface PlayOptions {
  /** Wait for playback to complete before resolving (default: true) */
  waitForEnd?: boolean;
  /** Timeout in ms (default: 60000) */
  timeout?: number;
}

/** State of the injected audio input system */
export interface AudioInputState {
  /** AudioContext state */
  contextState: 'not-created' | 'running' | 'suspended' | 'closed';
  /** Whether audio is currently playing */
  isPlaying: boolean;
  /** Sample rate of the AudioContext */
  sampleRate: number;
}

/** Options for a full audio round-trip */
export interface RoundTripOptions {
  /** Audio data to send as microphone input (WAV, MP3, OGG, etc.) */
  input: ArrayBuffer | Uint8Array;
  /** Ms of silence before considering the agent "done talking". Default: 1500 */
  silenceTimeout?: number;
  /** RMS threshold for silence. Default: 0.01 */
  silenceThreshold?: number;
  /** Max total time for the round trip in ms. Default: 120000 (2 min) */
  timeout?: number;
  /** Delay before starting input playback (let page initialize) in ms. Default: 0 */
  preDelay?: number;
  /** Selector to click after audio input finishes (for push-to-talk UIs). */
  sendSelector?: string | string[];
}

/** Result of a full audio round-trip */
export interface RoundTripResult {
  /** Captured audio response */
  audio: CaptureResult;
  /** Time from input start to first non-silent output chunk (ms), -1 if no audio received */
  latencyMs: number;
  /** Total round-trip time in ms */
  totalMs: number;
}
