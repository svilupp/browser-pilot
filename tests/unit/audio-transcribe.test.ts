/**
 * Unit tests for audio transcription module
 */

import { describe, expect, test } from 'bun:test';
import { isTranscriptionAvailable, transcribe } from '../../src/audio/transcribe.ts';
import type { CaptureResult } from '../../src/audio/types.ts';

function emptyCaptureResult(): CaptureResult {
  return {
    left: new Float32Array(0),
    right: new Float32Array(0),
    sampleRate: 48000,
    durationMs: 0,
    chunkCount: 0,
  };
}

function fakeCaptureResult(samples = 4800): CaptureResult {
  const left = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    left[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
  }
  return {
    left,
    right: new Float32Array(samples),
    sampleRate: 48000,
    durationMs: (samples / 48000) * 1000,
    chunkCount: 1,
  };
}

describe('isTranscriptionAvailable', () => {
  test('returns boolean', () => {
    const result = isTranscriptionAvailable();
    expect(typeof result).toBe('boolean');
  });
});

describe('transcribe', () => {
  test('returns empty text for empty audio', async () => {
    const result = await transcribe(emptyCaptureResult(), { apiKey: 'test-key' });
    expect(result.text).toBe('');
    expect(result.audioDurationMs).toBe(0);
    expect(result.apiDurationMs).toBe(0);
  });

  test('throws without API key', async () => {
    // Temporarily ensure OPENAI_API_KEY is not set for this test
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = undefined;

    try {
      await expect(transcribe(fakeCaptureResult())).rejects.toThrow('API key required');
    } finally {
      if (original) process.env.OPENAI_API_KEY = original;
    }
  });

  test('throws on API error', async () => {
    // Use a clearly invalid key — will fail auth
    await expect(transcribe(fakeCaptureResult(), { apiKey: 'sk-invalid-test' })).rejects.toThrow(
      'Whisper API error'
    );
  });
});
