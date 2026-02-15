/**
 * Thin OpenAI Whisper transcription wrapper
 *
 * Zero dependencies — uses only fetch(). Gated on OPENAI_API_KEY env var.
 * Accepts raw PCM/WAV audio and returns transcript text.
 */

import { pcmToWav } from './encoding.ts';
import type { CaptureResult } from './types.ts';

export interface TranscribeOptions {
  /** OpenAI API key. Defaults to OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Whisper model to use. Default: 'whisper-1' */
  model?: string;
  /** Language hint (BCP-47, e.g. 'en'). Optional — Whisper auto-detects. */
  language?: string;
  /** Response format. Default: 'text' */
  responseFormat?: 'text' | 'json' | 'verbose_json' | 'srt' | 'vtt';
  /** Optional prompt to guide the model (e.g. domain terms). */
  prompt?: string;
}

export interface TranscribeResult {
  /** Transcript text */
  text: string;
  /** Duration of the audio in ms */
  audioDurationMs: number;
  /** Time spent on the API call in ms */
  apiDurationMs: number;
}

/**
 * Transcribe a CaptureResult using OpenAI Whisper API.
 *
 * Requires OPENAI_API_KEY env var or apiKey option.
 * Returns the transcript text with timing metadata.
 *
 * @example
 * ```typescript
 * const capture = await page.audioOutput.stop();
 * const result = await transcribe(capture);
 * console.log(result.text);
 * ```
 */
export async function transcribe(
  audio: CaptureResult,
  options?: TranscribeOptions
): Promise<TranscribeResult> {
  const apiKey = options?.apiKey ?? getEnvVar('OPENAI_API_KEY');
  if (!apiKey) {
    throw new Error(
      'OpenAI API key required for transcription. ' +
        'Set OPENAI_API_KEY environment variable or pass apiKey option.'
    );
  }

  if (audio.left.length === 0) {
    return { text: '', audioDurationMs: 0, apiDurationMs: 0 };
  }

  const model = options?.model ?? 'whisper-1';
  const responseFormat = options?.responseFormat ?? 'text';

  // Convert CaptureResult to WAV bytes
  const wavBuffer = pcmToWav({
    left: audio.left,
    right: audio.right.length > 0 ? audio.right : undefined,
    sampleRate: audio.sampleRate,
  });

  // Build multipart form data
  const boundary = `----bpAudio${Date.now()}`;
  const parts: Uint8Array[] = [];

  // File part
  appendFormField(parts, boundary, 'file', new Uint8Array(wavBuffer), 'audio.wav', 'audio/wav');
  // Model
  appendFormTextField(parts, boundary, 'model', model);
  // Response format
  appendFormTextField(parts, boundary, 'response_format', responseFormat);
  // Optional language
  if (options?.language) {
    appendFormTextField(parts, boundary, 'language', options.language);
  }
  // Optional prompt
  if (options?.prompt) {
    appendFormTextField(parts, boundary, 'prompt', options.prompt);
  }

  // Closing boundary
  const closing = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  parts.push(closing);

  // Concatenate all parts
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }

  // Call OpenAI Whisper API
  const start = Date.now();
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const apiDurationMs = Date.now() - start;

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Whisper API error (${response.status}): ${errorBody}`);
  }

  let text: string;
  if (responseFormat === 'text') {
    text = (await response.text()).trim();
  } else {
    const json = (await response.json()) as { text: string };
    text = json.text ?? '';
  }

  return {
    text,
    audioDurationMs: audio.durationMs,
    apiDurationMs,
  };
}

/**
 * Check if transcription is available (API key is set).
 */
export function isTranscriptionAvailable(): boolean {
  return !!getEnvVar('OPENAI_API_KEY');
}

// --- Helpers ---

function getEnvVar(name: string): string | undefined {
  // Works in Node.js, Bun, and Deno
  if (typeof globalThis.process !== 'undefined' && globalThis.process.env) {
    return globalThis.process.env[name];
  }
  return undefined;
}

function appendFormTextField(
  parts: Uint8Array[],
  boundary: string,
  name: string,
  value: string
): void {
  const text = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`;
  parts.push(new TextEncoder().encode(text));
}

function appendFormField(
  parts: Uint8Array[],
  boundary: string,
  name: string,
  data: Uint8Array,
  filename: string,
  contentType: string
): void {
  const header =
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`;
  parts.push(new TextEncoder().encode(header));
  parts.push(data);
}
