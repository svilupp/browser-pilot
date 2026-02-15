/**
 * Audio command - Send and capture audio in a browser session
 *
 * Subcommands:
 *   play      Feed an audio file into the page's microphone
 *   capture   Capture audio output from the page
 *   roundtrip Play input audio and capture the response
 */

import { isTranscriptionAvailable, transcribe } from '../../audio/transcribe.ts';
import { connect, getBrowserWebSocketUrl, pcmToWav } from '../../index.ts';
import { output } from '../index.ts';
import {
  generateSessionId,
  getDefaultSession,
  loadSession,
  type SessionData,
  saveSession,
  updateSession,
} from '../session.ts';

const AUDIO_HELP = `
bp audio - Test voice/audio AI agents in the browser

Feed audio as microphone input, capture the agent's spoken response,
and optionally transcribe it. Designed for AI apps that respond with
audio (voice assistants, phone agents, audio chatbots).

Usage:
  bp audio <subcommand> [options]

Subcommands:
  roundtrip   Play input + capture response (full voice round-trip)
  play        Feed audio file into the page's fake microphone
  capture     Capture audio output from the page
  setup       Set up audio I/O on the session (auto-runs if needed)

Common Options:
  -s, --session [id]     Session to use (omit: auto-connect, -s: latest, -s <id>: specific)
  --transcribe           Transcribe captured audio via OpenAI Whisper
                         Requires OPENAI_API_KEY env var (validated immediately)
  --language <lang>      Language hint for transcription (e.g. 'en', 'es')
  --verbose              Show detailed capture diagnostics
  -h, --help             Show this help

Play Options:
  -i, --input <file>     Audio file to play (WAV, MP3, OGG)
  --no-wait              Don't wait for playback to finish

Capture Options:
  -o, --out <file>       Save captured audio to WAV file
  --duration <ms>        Capture for fixed duration (default: until silence)
  --silence-timeout <ms> Stop after N ms of silence (default: 3000)
  --silence-threshold <n> RMS threshold for silence (default: 0.01)
  --max-duration <ms>    Maximum capture time (default: 300000)

Roundtrip Options:
  -i, --input <file>     Audio file to send as microphone input
  -o, --out <file>       Save response audio to WAV file
  --silence-timeout <ms> Stop after N ms of silence (default: 3000)
  --pre-delay <ms>       Wait before playing input (default: 0)
  --timeout <ms>         Max total round-trip time (default: 120000)
  --send-selector <sel>  Click this selector after input finishes (push-to-talk)

Voice Agent Testing (typical workflow):
  # 1. Connect to browser running your voice agent
  bp connect --provider generic --name voice-test

  # 2. Navigate to the voice agent page
  bp exec '{"action":"goto","url":"https://my-voice-app.com"}'

  # 3. Full round-trip: send audio prompt, wait for response, transcribe
  bp audio roundtrip -i question.wav --transcribe --silence-timeout 5000
  # Output: { "transcript": "The answer is 42", "latencyMs": 1200, ... }

  # 4. Capture-only (agent already speaking)
  bp audio capture --transcribe --silence-timeout 8000

  # 5. Save response audio for inspection
  bp audio roundtrip -i prompt.wav -o response.wav --transcribe

Tips:
  - Voice agents often take 2-8s to respond. Use --silence-timeout 5000
    or higher to avoid cutting off responses.
  - Use --pre-delay if the page needs time after audio injection.
  - --transcribe adds ~1-2s (Whisper is fast). Safe in hot loop.
  - Use --json for structured output in CI/scripting.

Environment:
  OPENAI_API_KEY    Required for --transcribe. Validated immediately on use.
                    Get one at: https://platform.openai.com/api-keys
`;

interface AudioOptions {
  subcommand?: string;
  input?: string;
  out?: string;
  noWait?: boolean;
  duration?: number;
  silenceTimeout?: number;
  silenceThreshold?: number;
  maxDuration?: number;
  preDelay?: number;
  timeout?: number;
  doTranscribe?: boolean;
  language?: string;
  verbose?: boolean;
  sendSelector?: string;
  help?: boolean;
  useLatestSession?: boolean;
}

function parseAudioArgs(args: string[]): AudioOptions {
  const options: AudioOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '-i' || arg === '--input') {
      options.input = args[++i];
    } else if (arg === '-o' || arg === '--out') {
      options.out = args[++i];
    } else if (arg === '--no-wait') {
      options.noWait = true;
    } else if (arg === '--duration') {
      options.duration = Number.parseInt(args[++i] ?? '', 10);
    } else if (arg === '--silence-timeout') {
      options.silenceTimeout = Number.parseInt(args[++i] ?? '', 10);
    } else if (arg === '--silence-threshold') {
      options.silenceThreshold = Number.parseFloat(args[++i] ?? '');
    } else if (arg === '--max-duration') {
      options.maxDuration = Number.parseInt(args[++i] ?? '', 10);
    } else if (arg === '--pre-delay') {
      options.preDelay = Number.parseInt(args[++i] ?? '', 10);
    } else if (arg === '--timeout') {
      options.timeout = Number.parseInt(args[++i] ?? '', 10);
    } else if (arg === '--transcribe') {
      options.doTranscribe = true;
    } else if (arg === '--language') {
      options.language = args[++i];
    } else if (arg === '--verbose') {
      options.verbose = true;
    } else if (arg === '--send-selector') {
      options.sendSelector = args[++i];
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-s' || arg === '--session') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('-')) {
        options.useLatestSession = true;
      }
    } else if (!arg.startsWith('-') && !options.subcommand) {
      options.subcommand = arg;
    }
  }

  return options;
}

async function resolveConnection(
  sessionId: string | undefined,
  useLatestSession: boolean,
  trace: boolean
) {
  if (sessionId) {
    const session = await loadSession(sessionId);
    const browser = await connect({
      provider: session.provider,
      wsUrl: session.wsUrl,
      debug: trace,
    });
    return { browser, session, isNewSession: false };
  }

  if (useLatestSession) {
    const session = await getDefaultSession();
    if (!session) {
      throw new Error('No sessions found. Run "bp connect" first or omit -s to auto-connect.');
    }
    const browser = await connect({
      provider: session.provider,
      wsUrl: session.wsUrl,
      debug: trace,
    });
    return { browser, session, isNewSession: false };
  }

  // Auto-connect to local browser
  let wsUrl: string;
  try {
    wsUrl = await getBrowserWebSocketUrl('localhost:9222');
  } catch {
    throw new Error(
      'Could not auto-discover browser.\n' +
        'Either:\n' +
        '  1. Start Chrome with: --remote-debugging-port=9222\n' +
        '  2. Use an existing session: bp audio -s <session-id>\n' +
        '  3. Use latest session: bp audio -s'
    );
  }

  const browser = await connect({ provider: 'generic', wsUrl, debug: trace });
  const page = await browser.page();
  const currentUrl = await page.url();
  const newSessionId = generateSessionId();

  const session: SessionData = {
    id: newSessionId,
    provider: 'generic',
    wsUrl: browser.wsUrl,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    currentUrl,
  };

  await saveSession(session);
  return { browser, session, isNewSession: true };
}

async function readInputFile(filePath: string): Promise<Uint8Array> {
  const fs = await import('node:fs/promises');
  const buffer = await fs.readFile(filePath);
  return new Uint8Array(buffer);
}

async function writeWavFile(filePath: string, data: ArrayBuffer): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.writeFile(filePath, new Uint8Array(data));
}

export async function audioCommand(
  args: string[],
  globalOptions: { session?: string; output?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  const options = parseAudioArgs(args);

  if (options.help || globalOptions.help || !options.subcommand) {
    console.log(AUDIO_HELP);
    return;
  }

  if (options.doTranscribe && !isTranscriptionAvailable()) {
    throw new Error(
      'Transcription requires OPENAI_API_KEY environment variable.\n' +
        'Set it with: export OPENAI_API_KEY=sk-...'
    );
  }

  const { browser, session, isNewSession } = await resolveConnection(
    globalOptions.session,
    options.useLatestSession ?? false,
    globalOptions.trace ?? false
  );

  if (isNewSession) {
    console.log(`Created new session: ${session.id}`);
  }

  try {
    const page = await browser.page(undefined, { targetId: session.targetId });

    switch (options.subcommand) {
      case 'setup': {
        await page.setupAudio();
        const msg = 'Audio I/O set up (microphone override + output capture ready)';
        output(
          globalOptions.output === 'json' ? { success: true, message: msg } : msg,
          globalOptions.output
        );
        break;
      }

      case 'play': {
        if (!options.input) {
          throw new Error('--input / -i is required for play. Usage: bp audio play -i audio.wav');
        }

        const audioData = await readInputFile(options.input);
        console.log(`Playing ${options.input} (${audioData.length} bytes)...`);

        const start = Date.now();
        await page.audioInput.play(audioData, { waitForEnd: !options.noWait });
        const durationMs = Date.now() - start;

        const result = { success: true, file: options.input, durationMs };
        output(
          globalOptions.output === 'json' ? result : `Playback complete (${durationMs}ms)`,
          globalOptions.output
        );
        break;
      }

      case 'capture': {
        console.log('Capturing audio output...');

        if (options.verbose) {
          const startTime = Date.now();
          page.audioOutput.onDiag((msg) => {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`  [${elapsed}s] ${msg}`);
          });
        }

        let capture: Awaited<ReturnType<typeof page.audioOutput.stop>>;
        if (options.duration && options.duration > 0) {
          await page.audioOutput.start();
          await sleep(options.duration);
          capture = await page.audioOutput.stop();
        } else {
          capture = await page.audioOutput.captureUntilSilence({
            silenceTimeout: options.silenceTimeout ?? 3000,
            silenceThreshold: options.silenceThreshold ?? 0.01,
            maxDuration: options.maxDuration ?? 300000,
          });
        }

        if (options.out) {
          const wav = pcmToWav({
            left: capture.left,
            right: capture.right.length > 0 ? capture.right : undefined,
            sampleRate: capture.sampleRate,
          });
          await writeWavFile(options.out, wav);
          console.log(`Saved to ${options.out}`);
        }

        let transcript: string | undefined;
        if (options.doTranscribe && capture.left.length > 0) {
          console.log('Transcribing...');
          const tr = await transcribe(capture, { language: options.language });
          transcript = tr.text;
          console.log(`Transcript (${tr.apiDurationMs}ms): ${tr.text}`);
        }

        const result = {
          success: true,
          durationMs: Math.round(capture.durationMs),
          sampleRate: capture.sampleRate,
          samples: capture.left.length,
          chunks: capture.chunkCount,
          ...(options.out ? { file: options.out } : {}),
          ...(transcript !== undefined ? { transcript } : {}),
        };
        output(result, globalOptions.output);
        break;
      }

      case 'roundtrip': {
        if (!options.input) {
          throw new Error(
            '--input / -i is required for roundtrip. Usage: bp audio roundtrip -i prompt.wav'
          );
        }

        const audioData = await readInputFile(options.input);
        console.log(`Round-trip: playing ${options.input}, waiting for response...`);

        if (options.verbose) {
          const startTime = Date.now();
          page.audioOutput.onDiag((msg) => {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`  [${elapsed}s] ${msg}`);
          });
        }

        const result = await page.audioRoundTrip({
          input: audioData,
          silenceTimeout: options.silenceTimeout ?? 3000,
          silenceThreshold: options.silenceThreshold,
          timeout: options.timeout ?? 120000,
          preDelay: options.preDelay,
          sendSelector: options.sendSelector,
        });

        if (options.out && result.audio.left.length > 0) {
          const wav = pcmToWav({
            left: result.audio.left,
            right: result.audio.right.length > 0 ? result.audio.right : undefined,
            sampleRate: result.audio.sampleRate,
          });
          await writeWavFile(options.out, wav);
          console.log(`Response audio saved to ${options.out}`);
        }

        let transcript: string | undefined;
        if (options.doTranscribe && result.audio.left.length > 0) {
          console.log('Transcribing response...');
          const tr = await transcribe(result.audio, { language: options.language });
          transcript = tr.text;
          console.log(`Transcript (${tr.apiDurationMs}ms): ${tr.text}`);
        }

        const outputData = {
          success: true,
          latencyMs: result.latencyMs,
          totalMs: result.totalMs,
          audio: {
            durationMs: Math.round(result.audio.durationMs),
            sampleRate: result.audio.sampleRate,
            samples: result.audio.left.length,
            chunks: result.audio.chunkCount,
          },
          ...(options.out ? { file: options.out } : {}),
          ...(transcript !== undefined ? { transcript } : {}),
        };
        output(outputData, globalOptions.output);
        break;
      }

      default:
        throw new Error(
          `Unknown audio subcommand: ${options.subcommand}\n` +
            'Available: setup, play, capture, roundtrip'
        );
    }

    const currentUrl = await page.url();
    await updateSession(session.id, { currentUrl });
  } finally {
    await browser.disconnect();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
