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
  test('returns boolean based on OPENAI_API_KEY', () => {
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

  test('throws without API key when env var is unset', async () => {
    const original = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = undefined;

    try {
      await expect(transcribe(fakeCaptureResult())).rejects.toThrow('API key required');
    } finally {
      if (original) process.env['OPENAI_API_KEY'] = original;
    }
  });

  test('constructs correct WAV and calls Whisper API', async () => {
    // Mock fetch to verify the request is well-formed
    const originalFetch = globalThis.fetch;
    let capturedRequest: {
      url: string;
      method: string;
      headers: Record<string, string>;
      bodyLength: number;
    } | null = null;

    // @ts-expect-error -- minimal mock, Bun's fetch has extra properties
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      capturedRequest = {
        url,
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(Object.entries(init?.headers ?? {})),
        bodyLength: init?.body ? (init.body as Uint8Array).length : 0,
      };
      return new Response(JSON.stringify({ text: 'hello world' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    try {
      const result = await transcribe(fakeCaptureResult(), {
        apiKey: 'sk-test-key',
        responseFormat: 'json',
        language: 'en',
      });

      expect(result.text).toBe('hello world');
      expect(result.apiDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.audioDurationMs).toBe(100); // 4800 samples at 48kHz

      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.url).toBe('https://api.openai.com/v1/audio/transcriptions');
      expect(capturedRequest!.method).toBe('POST');
      expect(capturedRequest!.headers['Authorization']).toBe('Bearer sk-test-key');
      expect(capturedRequest!.headers['Content-Type']).toContain('multipart/form-data');
      expect(capturedRequest!.bodyLength).toBeGreaterThan(44); // At least WAV header
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('throws on API error response', async () => {
    const originalFetch = globalThis.fetch;
    // @ts-expect-error -- minimal mock
    globalThis.fetch = async () => {
      return new Response('Unauthorized', { status: 401 });
    };

    try {
      await expect(transcribe(fakeCaptureResult(), { apiKey: 'sk-bad-key' })).rejects.toThrow(
        'Whisper API error (401)'
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
