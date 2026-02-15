/**
 * Audio I/O module exports
 */

export {
  base64ToBuffer,
  bufferToBase64,
  calculateRMS,
  decodeAudioChunk,
  generateSilence,
  generateTone,
  parseWavHeader,
  pcmToWav,
} from './encoding.ts';
export { type AudioFlagOptions, getAudioChromeFlags } from './flags.ts';
export { AudioInput } from './input.ts';
export { AudioOutput } from './output.ts';
export { grantAudioPermissions } from './permissions.ts';
export type {
  AudioChunk,
  AudioInputState,
  CaptureOptions,
  CaptureResult,
  PlayOptions,
  RoundTripOptions,
  RoundTripResult,
} from './types.ts';
