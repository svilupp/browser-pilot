/**
 * Audio encoding utilities — zero dependencies
 *
 * Handles base64 conversion, PCM/WAV encoding/decoding,
 * RMS calculation, and test signal generation.
 */

import type { AudioChunk } from './types.ts';

/**
 * Convert ArrayBuffer or Uint8Array to base64 string.
 */
export function bufferToBase64(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Decode base64 string to Uint8Array.
 */
export function base64ToBuffer(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decode a base64-encoded Float32Array PCM chunk received from the browser.
 */
export function decodeAudioChunk(data: {
  left: string;
  right: string;
  sampleRate: number;
  samples: number;
}): AudioChunk {
  const leftBytes = base64ToBuffer(data.left);
  const rightBytes = base64ToBuffer(data.right);
  return {
    left: new Float32Array(leftBytes.buffer),
    right: new Float32Array(rightBytes.buffer),
    sampleRate: data.sampleRate,
    samples: data.samples,
    timestamp: Date.now(),
  };
}

/**
 * Calculate RMS (root mean square) of a Float32Array signal.
 * Returns 0 for empty arrays.
 */
export function calculateRMS(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i]! * samples[i]!;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Generate a WAV file from PCM Float32 data.
 * Encodes as 16-bit PCM WAV.
 */
export function pcmToWav(options: {
  left: Float32Array;
  right?: Float32Array;
  sampleRate: number;
}): ArrayBuffer {
  const { left, right, sampleRate } = options;
  const numChannels = right ? 2 : 1;
  const numSamples = left.length;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataLength = numSamples * blockAlign;
  const headerLength = 44;
  const buffer = new ArrayBuffer(headerLength + dataLength);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');

  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const leftSample = Math.max(-1, Math.min(1, left[i]!));
    view.setInt16(offset, leftSample < 0 ? leftSample * 0x8000 : leftSample * 0x7fff, true);
    offset += 2;

    if (right) {
      const rightSample = Math.max(-1, Math.min(1, right[i]!));
      view.setInt16(offset, rightSample < 0 ? rightSample * 0x8000 : rightSample * 0x7fff, true);
      offset += 2;
    }
  }

  return buffer;
}

/**
 * Parse a WAV file header to extract metadata.
 * Throws if the data is not a valid WAV file.
 */
export function parseWavHeader(data: ArrayBuffer): {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
} {
  const view = new DataView(data);

  if (data.byteLength < 44) {
    throw new Error('Invalid WAV: file too small');
  }

  const riff = readString(view, 0, 4);
  const wave = readString(view, 8, 4);
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error('Invalid WAV: missing RIFF/WAVE header');
  }

  const fmt = readString(view, 12, 4);
  if (fmt !== 'fmt ') {
    throw new Error('Invalid WAV: missing fmt chunk');
  }

  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);

  // Find the data chunk (it may not be at offset 36 if there are extra chunks)
  let dataOffset = 36;
  while (dataOffset < data.byteLength - 8) {
    const chunkId = readString(view, dataOffset, 4);
    const chunkSize = view.getUint32(dataOffset + 4, true);
    if (chunkId === 'data') {
      return {
        sampleRate,
        channels,
        bitsPerSample,
        dataOffset: dataOffset + 8,
        dataLength: chunkSize,
      };
    }
    dataOffset += 8 + chunkSize;
  }

  throw new Error('Invalid WAV: missing data chunk');
}

/**
 * Generate silence as Float32Array.
 */
export function generateSilence(durationMs: number, sampleRate = 48000): Float32Array {
  return new Float32Array(Math.ceil((sampleRate * durationMs) / 1000));
}

/**
 * Generate a sine wave tone (useful for testing audio pipelines).
 */
export function generateTone(
  frequency: number,
  durationMs: number,
  sampleRate = 48000,
  amplitude = 0.5
): Float32Array {
  const numSamples = Math.ceil((sampleRate * durationMs) / 1000);
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return samples;
}

// --- Helpers ---

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function readString(view: DataView, offset: number, length: number): string {
  let str = '';
  for (let i = 0; i < length; i++) {
    str += String.fromCharCode(view.getUint8(offset + i));
  }
  return str;
}
