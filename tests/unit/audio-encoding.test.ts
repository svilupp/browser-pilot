/**
 * Unit tests for audio encoding utilities
 */

import { describe, expect, test } from 'bun:test';
import {
  base64ToBuffer,
  bufferToBase64,
  calculateRMS,
  decodeAudioChunk,
  generateSilence,
  generateTone,
  parseWavHeader,
  pcmToWav,
} from '../../src/audio/encoding.ts';

describe('bufferToBase64 / base64ToBuffer', () => {
  test('round-trips empty buffer', () => {
    const original = new Uint8Array(0);
    const b64 = bufferToBase64(original);
    const decoded = base64ToBuffer(b64);
    expect(decoded.length).toBe(0);
  });

  test('round-trips small buffer', () => {
    const original = new Uint8Array([0, 1, 2, 127, 128, 255]);
    const b64 = bufferToBase64(original);
    const decoded = base64ToBuffer(b64);
    expect(decoded).toEqual(original);
  });

  test('round-trips ArrayBuffer', () => {
    const original = new Uint8Array([10, 20, 30]).buffer;
    const b64 = bufferToBase64(original);
    const decoded = base64ToBuffer(b64);
    expect(decoded).toEqual(new Uint8Array(original));
  });

  test('round-trips larger buffer (1KB)', () => {
    const original = new Uint8Array(1024);
    for (let i = 0; i < original.length; i++) {
      original[i] = i % 256;
    }
    const b64 = bufferToBase64(original);
    const decoded = base64ToBuffer(b64);
    expect(decoded).toEqual(original);
  });
});

describe('calculateRMS', () => {
  test('returns 0 for empty array', () => {
    expect(calculateRMS(new Float32Array(0))).toBe(0);
  });

  test('returns 0 for silence', () => {
    const silence = new Float32Array(1000);
    expect(calculateRMS(silence)).toBe(0);
  });

  test('returns correct value for constant signal', () => {
    // RMS of a constant 0.5 signal should be 0.5
    const signal = new Float32Array(1000).fill(0.5);
    expect(calculateRMS(signal)).toBeCloseTo(0.5, 5);
  });

  test('returns correct value for full-scale signal', () => {
    const signal = new Float32Array(1000).fill(1.0);
    expect(calculateRMS(signal)).toBeCloseTo(1.0, 5);
  });

  test('returns correct value for sine wave', () => {
    // RMS of a sine wave with amplitude A is A/sqrt(2)
    const amplitude = 0.8;
    const tone = generateTone(440, 1000, 48000, amplitude);
    const expectedRMS = amplitude / Math.sqrt(2);
    expect(calculateRMS(tone)).toBeCloseTo(expectedRMS, 1);
  });
});

describe('generateSilence', () => {
  test('generates correct length for 1 second at 48kHz', () => {
    const silence = generateSilence(1000, 48000);
    expect(silence.length).toBe(48000);
  });

  test('generates correct length for 500ms at default rate', () => {
    const silence = generateSilence(500);
    expect(silence.length).toBe(24000);
  });

  test('all values are zero', () => {
    const silence = generateSilence(100, 48000);
    for (let i = 0; i < silence.length; i++) {
      expect(silence[i]).toBe(0);
    }
  });
});

describe('generateTone', () => {
  test('generates correct sample count', () => {
    const tone = generateTone(440, 1000, 48000);
    expect(tone.length).toBe(48000);
  });

  test('generates correct sample count for 500ms', () => {
    const tone = generateTone(440, 500, 44100);
    expect(tone.length).toBe(22050);
  });

  test('values are within amplitude range', () => {
    const amplitude = 0.5;
    const tone = generateTone(440, 100, 48000, amplitude);
    for (let i = 0; i < tone.length; i++) {
      expect(Math.abs(tone[i]!)).toBeLessThanOrEqual(amplitude + 0.001);
    }
  });

  test('produces correct frequency (zero-crossing count)', () => {
    const frequency = 440;
    const sampleRate = 48000;
    const tone = generateTone(frequency, 1000, sampleRate);

    // Count positive zero-crossings
    let crossings = 0;
    for (let i = 1; i < tone.length; i++) {
      if (tone[i - 1]! < 0 && tone[i]! >= 0) crossings++;
    }

    // Should have ~440 positive zero-crossings per second
    expect(crossings).toBeGreaterThan(frequency - 5);
    expect(crossings).toBeLessThan(frequency + 5);
  });

  test('default amplitude is 0.5', () => {
    const tone = generateTone(440, 100, 48000);
    const maxVal = Math.max(...tone);
    expect(maxVal).toBeCloseTo(0.5, 1);
  });
});

describe('pcmToWav', () => {
  test('produces valid WAV header for mono', () => {
    const pcm = generateTone(440, 100, 48000);
    const wav = pcmToWav({ left: pcm, sampleRate: 48000 });

    const view = new DataView(wav);
    // RIFF header
    expect(
      String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))
    ).toBe('RIFF');
    // WAVE
    expect(
      String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))
    ).toBe('WAVE');
    // fmt
    expect(
      String.fromCharCode(
        view.getUint8(12),
        view.getUint8(13),
        view.getUint8(14),
        view.getUint8(15)
      )
    ).toBe('fmt ');
    // PCM format (1)
    expect(view.getUint16(20, true)).toBe(1);
    // 1 channel
    expect(view.getUint16(22, true)).toBe(1);
    // Sample rate
    expect(view.getUint32(24, true)).toBe(48000);
    // 16-bit
    expect(view.getUint16(34, true)).toBe(16);
  });

  test('produces valid WAV header for stereo', () => {
    const left = generateTone(440, 100, 48000);
    const right = generateTone(880, 100, 48000);
    const wav = pcmToWav({ left, right, sampleRate: 48000 });

    const view = new DataView(wav);
    // 2 channels
    expect(view.getUint16(22, true)).toBe(2);
    // Block align = 2 channels * 2 bytes
    expect(view.getUint16(32, true)).toBe(4);
  });

  test('produces correct file size for mono', () => {
    const numSamples = 4800; // 100ms at 48kHz
    const pcm = new Float32Array(numSamples);
    const wav = pcmToWav({ left: pcm, sampleRate: 48000 });

    // 44 header + numSamples * 2 bytes (16-bit mono)
    expect(wav.byteLength).toBe(44 + numSamples * 2);
  });

  test('produces correct file size for stereo', () => {
    const numSamples = 4800;
    const left = new Float32Array(numSamples);
    const right = new Float32Array(numSamples);
    const wav = pcmToWav({ left, right, sampleRate: 48000 });

    // 44 header + numSamples * 4 bytes (16-bit stereo)
    expect(wav.byteLength).toBe(44 + numSamples * 4);
  });

  test('round-trips through parseWavHeader', () => {
    const left = generateTone(440, 500, 44100);
    const wav = pcmToWav({ left, sampleRate: 44100 });
    const header = parseWavHeader(wav);

    expect(header.sampleRate).toBe(44100);
    expect(header.channels).toBe(1);
    expect(header.bitsPerSample).toBe(16);
    expect(header.dataOffset).toBe(44);
    expect(header.dataLength).toBe(left.length * 2);
  });
});

describe('parseWavHeader', () => {
  test('throws on too-small buffer', () => {
    expect(() => parseWavHeader(new ArrayBuffer(10))).toThrow('too small');
  });

  test('throws on non-WAV data', () => {
    const buf = new ArrayBuffer(44);
    expect(() => parseWavHeader(buf)).toThrow('RIFF/WAVE');
  });

  test('parses stereo WAV correctly', () => {
    const left = generateTone(440, 100, 48000);
    const right = generateTone(880, 100, 48000);
    const wav = pcmToWav({ left, right, sampleRate: 48000 });
    const header = parseWavHeader(wav);

    expect(header.channels).toBe(2);
    expect(header.sampleRate).toBe(48000);
    expect(header.bitsPerSample).toBe(16);
  });
});

describe('decodeAudioChunk', () => {
  test('decodes base64 PCM data correctly', () => {
    // Create known Float32Array data
    const leftData = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const rightData = new Float32Array([0.5, 0.6, 0.7, 0.8]);

    const leftB64 = bufferToBase64(new Uint8Array(leftData.buffer));
    const rightB64 = bufferToBase64(new Uint8Array(rightData.buffer));

    const chunk = decodeAudioChunk({
      left: leftB64,
      right: rightB64,
      sampleRate: 48000,
      samples: 4,
    });

    expect(chunk.sampleRate).toBe(48000);
    expect(chunk.samples).toBe(4);
    expect(chunk.left.length).toBe(4);
    expect(chunk.right.length).toBe(4);
    expect(chunk.left[0]).toBeCloseTo(0.1, 5);
    expect(chunk.right[3]).toBeCloseTo(0.8, 5);
    expect(chunk.timestamp).toBeGreaterThan(0);
  });
});
