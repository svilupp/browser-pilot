/**
 * Audio command - Send and capture audio in a browser session
 *
 * Subcommands:
 *   play      Feed an audio file into the page's microphone
 *   capture   Capture audio output from the page
 *   roundtrip Play input audio and capture the response
 *   check     Validate audio pipeline and report status
 */

import { isTranscriptionAvailable, transcribe } from '../../audio/transcribe.ts';
import { pcmToWav } from '../../index.ts';
import { isRecord } from '../../utils/json.ts';
import { attachSession } from '../attach.ts';
import { formatBrowserDiscoveryError, resolveCLIEndpoint } from '../browser-endpoint.ts';
import { createLocalSession } from '../connect-service.ts';
import { output } from '../output.ts';
import { getDefaultSession, loadSession, updateSession } from '../session.ts';
import { getSessionLogger } from '../session-logger.ts';

const AUDIO_HELP = `
bp audio - Actively exercise voice and audio pipelines

When to use:
  You need to inject microphone input, capture spoken output, or quickly validate a voice stack.

When not to use:
  You are investigating cross-cutting failure causes over time. Use \`bp trace summary --view voice\` after capture.

Default flow:
  setup -> goto or activate the app -> check -> roundtrip or capture -> trace summary

Common mistake:
  Injecting overrides after the app already created its audio pipeline.

Feed audio as microphone input, capture the agent's spoken response,
and optionally transcribe it. Designed for AI apps that respond with
audio (voice assistants, phone agents, audio chatbots).

Usage:
  bp audio <subcommand> [options]

Subcommands:
  setup       Inject audio hooks into the session
  check       Validate the current audio pipeline
  roundtrip   Play input + capture response (full voice round-trip)
  play        Feed audio file into the page's fake microphone
  capture     Capture audio output from the page

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
  --silence-timeout <ms> Stop after N ms of silence (default: 1500)
  --silence-threshold <n> RMS threshold for silence (default: 0.01)
  --max-duration <ms>    Maximum capture time (default: 300000)

Roundtrip Options:
  -i, --input <file>     Audio file to send as microphone input
  -o, --out <file>       Save response audio to WAV file
  --silence-timeout <ms> Stop after N ms of silence (default: 1500)
  --pre-delay <ms>       Wait before playing input (default: 0)
  --timeout <ms>         Max total round-trip time (default: 120000)
  --send-selector <sel>  Click this selector after input finishes (push-to-talk)

Typical workflows:
  Click-to-start app:
    bp audio setup -s vt
    bp exec -s vt '{"action":"goto","url":"https://my-voice-app.com"}'
    bp snapshot -i -s vt
    bp exec -s vt '{"action":"click","selector":"ref:e4"}'
    bp audio check -s vt
    bp audio roundtrip -s vt -i prompt.wav --transcribe -o response.wav

  Auto-start app:
    bp audio setup -s vt
    bp exec -s vt '{"action":"goto","url":"https://my-voice-app.com"}'
    bp audio check -s vt
    bp audio roundtrip -s vt -i prompt.wav --transcribe

Likely next commands:
  bp trace summary -s vt --view voice
  bp record -s vt --profile voice -f ./artifacts/voice.recording.json
  bp env permissions grant -s vt microphone

Tips:
  - \`bp audio check\` is the first diagnostic command.
  - If you see 0 AudioContexts, the app has not initialized yet.
  - If you see NOT READY, run \`bp audio setup\` and reload or re-open the app flow.
  - Use \`--send-selector\` for push-to-talk UIs.
  - Use \`bp trace summary --view voice\` when the question is causal, not just operational.

Environment:
  OPENAI_API_KEY    Required for --transcribe. Validated immediately on use.
                    Get one at: https://platform.openai.com/api-keys
`;

export interface AudioOptions {
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

export function parseAudioArgs(args: string[]): AudioOptions {
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
    const { browser } = await attachSession(session, { trace });
    return { browser, session, isNewSession: false };
  }

  if (useLatestSession) {
    const session = await getDefaultSession();
    if (!session) {
      throw new Error('No sessions found. Run "bp connect" first or omit -s to auto-connect.');
    }
    const { browser } = await attachSession(session, { trace });
    return { browser, session, isNewSession: false };
  }

  // Auto-connect to local browser
  let endpoint: Awaited<ReturnType<typeof resolveCLIEndpoint>>;
  try {
    endpoint = await resolveCLIEndpoint();
  } catch (error) {
    throw new Error(
      formatBrowserDiscoveryError(error, {
        explicitHint: '  - Create a session first: bp connect --browser-url <ws-url>',
        reuseSessionHint: 'bp audio -s <session-id>',
        latestSessionHint: 'bp audio -s',
      })
    );
  }

  const { browser, session } = await createLocalSession({
    wsUrl: endpoint.wsUrl,
    trace,
    connectionSource: endpoint.source,
    resolvedChannel: endpoint.channel,
    resolvedUserDataDir: endpoint.userDataDir,
  });
  return { browser, session, isNewSession: true };
}

async function readInputFile(filePath: string): Promise<Uint8Array> {
  const fs = await import('node:fs/promises');
  const buffer = await fs.readFile(filePath);
  return new Uint8Array(buffer);
}

async function getFileSize(filePath: string): Promise<number> {
  const fs = await import('node:fs/promises');
  const stat = await fs.stat(filePath);
  return stat.size;
}

function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function basename(filePath: string): string {
  return filePath.split('/').pop()?.split('\\').pop() ?? filePath;
}

async function writeWavFile(filePath: string, data: ArrayBuffer): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.writeFile(filePath, new Uint8Array(data));
}

// --- Audio check diagnostics ---

/** JS expression evaluated in the page to gather audio pipeline diagnostics */
const CHECK_DIAGNOSTICS_EXPRESSION = `
(function() {
  var getUserMediaOverridden = false;
  try {
    getUserMediaOverridden = navigator.mediaDevices.getUserMedia.toString().indexOf('native code') === -1;
  } catch(e) {}

  var connectOverridden = false;
  try {
    connectOverridden = AudioNode.prototype.connect !== window.__bpOrigConnect;
  } catch(e) {}

  var audioContextOverridden = !!window.__bpAudioContextOverridden;

  var contexts = (window.__bpTrackedAudioContexts || []).map(function(c) {
    return { sampleRate: c.sampleRate, state: c.state };
  });

  var input = null;
  if (window.__bpAudioInput) {
    var state = window.__bpAudioInput.getState();
    input = {
      contextState: state.contextState,
      isPlaying: state.isPlaying,
      sampleRate: state.sampleRate
    };
  }

  var outputStats = null;
  if (window.__bpAudioOutput) {
    outputStats = window.__bpAudioOutput.getStats();
  }

  return JSON.stringify({
    overrides: {
      getUserMedia: getUserMediaOverridden,
      connect: connectOverridden,
      audioContext: audioContextOverridden
    },
    contexts: contexts,
    input: input,
    output: outputStats,
    rtcDetails: outputStats ? outputStats.rtcDetails : [],
    mediaElementDetails: outputStats ? outputStats.mediaElementDetails : []
  });
})()
`;

interface CheckDiagnostics {
  overrides: {
    getUserMedia: boolean;
    connect: boolean;
    audioContext: boolean;
  };
  contexts: Array<{ sampleRate: number; state: string }>;
  input: { contextState: string; isPlaying: boolean; sampleRate: number } | null;
  output: {
    audioContexts: number;
    contextTaps: number;
    audioNodes: number;
    rtcConnections: number;
    mediaElements: number;
    pendingTracks: number;
    tappedTracks: number;
    capturing: boolean;
    bufferedSamples: number;
  } | null;
  rtcDetails: Array<{
    state: string;
    audioReceivers: number;
    audioSenders: number;
    tapped: boolean;
  }>;
  mediaElementDetails: Array<{
    tag: string;
    hasSrcObject: boolean;
    hasSrc: boolean;
    audioTracks: number;
    tapped: boolean;
  }>;
}

function classifyContextRole(
  sampleRate: number,
  index: number,
  contexts: Array<{ sampleRate: number; state: string }>
): string {
  const is48k = sampleRate === 48000;

  if (!is48k) {
    return 'agent';
  }

  // Among 48kHz contexts, first is input, last is capture
  const count48k = contexts.filter((c) => c.sampleRate === 48000).length;
  if (count48k >= 2) {
    const first48kIndex = contexts.findIndex((c) => c.sampleRate === 48000);
    const last48kIndex =
      contexts.length - 1 - [...contexts].reverse().findIndex((c) => c.sampleRate === 48000);
    if (index === first48kIndex) return 'input';
    if (index === last48kIndex) return 'capture';
  }

  if (count48k === 1) {
    return 'input';
  }

  return 'unknown';
}

function formatCheckPretty(diag: CheckDiagnostics): string {
  const lines: string[] = [];
  lines.push('Audio Pipeline Check');

  // Overrides section
  lines.push('  Overrides:');
  const ctxCount = diag.contexts.length;
  lines.push(
    `    getUserMedia:       ${diag.overrides.getUserMedia ? 'overridden' : 'NOT overridden'}`
  );
  lines.push(`    AudioNode.connect:  ${diag.overrides.connect ? 'overridden' : 'NOT overridden'}`);
  lines.push(
    `    AudioContext:       ${diag.overrides.audioContext ? `overridden (tracking ${ctxCount} context${ctxCount !== 1 ? 's' : ''})` : 'NOT overridden'}`
  );

  // AudioContexts section
  if (diag.contexts.length > 0) {
    lines.push('');
    lines.push('  AudioContexts:');
    for (let i = 0; i < diag.contexts.length; i++) {
      const ctx = diag.contexts[i]!;
      const role = classifyContextRole(ctx.sampleRate, i, diag.contexts);
      const roleLabel =
        role === 'input'
          ? '(browser-pilot input)'
          : role === 'capture'
            ? '(browser-pilot capture)'
            : role === 'agent'
              ? '(likely voice agent)'
              : '';
      lines.push(`    ${ctx.sampleRate} Hz  ${ctx.state}  ${roleLabel}`);
    }
  }

  // Input section
  lines.push('');
  if (diag.input) {
    const inputReady = diag.input.contextState === 'running';
    const label = inputReady ? 'ready' : diag.input.contextState;
    lines.push(
      `  Input (fake mic):  ${label} (${diag.input.sampleRate}Hz${diag.input.isPlaying ? ', playing' : ''})`
    );
  } else {
    lines.push('  Input (fake mic):  not set up');
  }

  // Output section
  if (diag.output) {
    const taps = diag.output.contextTaps;
    const capturing = diag.output.capturing;
    lines.push(
      `  Output (capture):  ready (${taps} tap${taps !== 1 ? 's' : ''}, ${capturing ? 'capturing' : 'not capturing'})`
    );
  } else {
    lines.push('  Output (capture):  not set up');
  }

  // WebRTC section
  if (diag.rtcDetails && diag.rtcDetails.length > 0) {
    lines.push('');
    lines.push('  RTCPeerConnections:');
    for (let i = 0; i < diag.rtcDetails.length; i++) {
      const pc = diag.rtcDetails[i]!;
      const tappedLabel = pc.tapped ? ', tapped' : '';
      lines.push(
        `    PC #${i + 1}: ${pc.state}, ${pc.audioReceivers} audio receiver${pc.audioReceivers !== 1 ? 's' : ''}${tappedLabel}, ${pc.audioSenders} audio sender${pc.audioSenders !== 1 ? 's' : ''}`
      );
    }
  }

  // Media elements section
  if (diag.mediaElementDetails && diag.mediaElementDetails.length > 0) {
    lines.push('');
    lines.push('  MediaElements:');
    for (let i = 0; i < diag.mediaElementDetails.length; i++) {
      const el = diag.mediaElementDetails[i]!;
      const parts: string[] = [`<${el.tag}>`];
      if (el.hasSrcObject) {
        parts.push(
          `srcObject (${el.audioTracks} audio track${el.audioTracks !== 1 ? 's' : ''}${el.tapped ? ', tapped' : ''})`
        );
      } else if (el.hasSrc) {
        parts.push('src attribute');
      }
      lines.push(`    ${parts.join(' ')}`);
    }
  }

  // Overall status
  lines.push('');
  const allOverrides =
    diag.overrides.getUserMedia && diag.overrides.connect && diag.overrides.audioContext;
  const inputReady = diag.input !== null && diag.input.contextState === 'running';
  const outputReady = diag.output !== null;
  const ready = allOverrides && inputReady && outputReady;

  if (ready) {
    lines.push('  Status: READY for roundtrip');
  } else {
    const issues: string[] = [];
    if (!diag.overrides.getUserMedia) issues.push('getUserMedia not overridden');
    if (!diag.overrides.connect) issues.push('AudioNode.connect not overridden');
    if (!diag.overrides.audioContext) issues.push('AudioContext not overridden');
    if (!inputReady) issues.push('input not ready');
    if (!outputReady) issues.push('output not set up');
    lines.push(`  Status: NOT READY (${issues.join(', ')})`);
  }

  return lines.join('\n');
}

interface CheckJsonResult {
  ready: boolean;
  overrides: { getUserMedia: boolean; connect: boolean; audioContext: boolean };
  audioContexts: Array<{ sampleRate: number; state: string; role: string }>;
  input: {
    ready: boolean;
    sampleRate: number;
    contextState: string;
    isPlaying: boolean;
  } | null;
  output: { ready: boolean; taps: number; capturing: boolean } | null;
  rtcPeerConnections: Array<{
    state: string;
    audioReceivers: number;
    audioSenders: number;
    tapped: boolean;
  }>;
  mediaElements: Array<{
    tag: string;
    hasSrcObject: boolean;
    hasSrc: boolean;
    audioTracks: number;
    tapped: boolean;
  }>;
  agentDetected: boolean;
  agentSampleRate: number | null;
}

function buildCheckJson(diag: CheckDiagnostics): CheckJsonResult {
  const audioContexts = diag.contexts.map((ctx, i) => ({
    sampleRate: ctx.sampleRate,
    state: ctx.state,
    role: classifyContextRole(ctx.sampleRate, i, diag.contexts),
  }));

  const agentCtx = audioContexts.find((c) => c.role === 'agent');

  const allOverrides =
    diag.overrides.getUserMedia && diag.overrides.connect && diag.overrides.audioContext;
  const inputReady = diag.input !== null && diag.input.contextState === 'running';
  const outputReady = diag.output !== null;

  return {
    ready: allOverrides && inputReady && outputReady,
    overrides: diag.overrides,
    audioContexts,
    input: diag.input
      ? {
          ready: diag.input.contextState === 'running',
          sampleRate: diag.input.sampleRate,
          contextState: diag.input.contextState,
          isPlaying: diag.input.isPlaying,
        }
      : null,
    output: diag.output
      ? {
          ready: true,
          taps: diag.output.contextTaps,
          capturing: diag.output.capturing,
        }
      : null,
    rtcPeerConnections: diag.rtcDetails ?? [],
    mediaElements: diag.mediaElementDetails ?? [],
    agentDetected: agentCtx !== undefined,
    agentSampleRate: agentCtx?.sampleRate ?? null,
  };
}

export async function audioCommand(
  args: string[],
  globalOptions: {
    session?: string;
    format?: 'json' | 'pretty';
    trace?: boolean;
    help?: boolean;
  }
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
  const logger = getSessionLogger(session.id, session.exportLog);

  if (isNewSession) {
    console.log(`Created new session: ${session.id}`);
  }

  try {
    const page = await browser.page(undefined, { targetId: session.targetId });

    switch (options.subcommand) {
      case 'setup': {
        await page.setupAudio();
        const msg = 'Audio I/O set up (microphone override + output capture ready)';
        logger.logTrace({
          channel: 'voice',
          event: 'voice.pipeline.ready',
          summary: msg,
          data: { subcommand: 'setup' },
        });
        output(
          globalOptions.format === 'json' ? { success: true, message: msg } : msg,
          globalOptions.format
        );
        break;
      }

      case 'check': {
        // Ensure audio overrides are injected (idempotent)
        await page.setupAudio();

        // Gather diagnostics from the page
        const rawDiag = await page.evaluate<string>(CHECK_DIAGNOSTICS_EXPRESSION);
        const parsedDiag: unknown = JSON.parse(rawDiag);
        if (!isRecord(parsedDiag)) throw new Error('Invalid audio diagnostics payload');
        const diag = parsedDiag as unknown as CheckDiagnostics;
        const checkJson = buildCheckJson(diag);
        logger.logTrace({
          channel: 'voice',
          event: checkJson.ready ? 'voice.pipeline.ready' : 'voice.pipeline.notReady',
          severity: checkJson.ready ? 'info' : 'error',
          summary: checkJson.ready ? 'Audio pipeline ready' : 'Audio pipeline not ready',
          data: { ...checkJson },
        });
        if (checkJson.agentDetected) {
          logger.logTrace({
            channel: 'media',
            event: 'media.track.started',
            summary: 'Audio track detected during audio check',
            data: { kind: 'audio', sampleRate: checkJson.agentSampleRate },
          });
        }

        if (globalOptions.format === 'json') {
          output(checkJson, 'json');
        } else {
          console.log(formatCheckPretty(diag));
        }
        break;
      }

      case 'play': {
        if (!options.input) {
          throw new Error('--input / -i is required for play. Usage: bp audio play -i audio.wav');
        }

        const audioData = await readInputFile(options.input);
        console.log(`Playing ${options.input} (${audioData.length} bytes)...`);

        const start = Date.now();
        logger.logTrace({
          channel: 'voice',
          event: 'voice.capture.started',
          summary: 'Audio playback started',
          data: { file: options.input },
        });
        await page.audioInput.play(audioData, { waitForEnd: !options.noWait });
        const durationMs = Date.now() - start;
        logger.logTrace({
          channel: 'voice',
          event: 'voice.capture.stopped',
          summary: 'Audio playback finished',
          data: { file: options.input, durationMs },
        });

        const result = { success: true, file: options.input, durationMs };
        output(
          globalOptions.format === 'json' ? result : `Playback complete (${durationMs}ms)`,
          globalOptions.format
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
        logger.logTrace({
          channel: 'media',
          event: 'media.playback.started',
          summary: 'Audio capture started',
          data: { subcommand: 'capture' },
        });
        if (options.duration && options.duration > 0) {
          await page.audioOutput.start();
          await sleep(options.duration);
          capture = await page.audioOutput.stop();
        } else {
          capture = await page.audioOutput.captureUntilSilence({
            silenceTimeout: options.silenceTimeout ?? 1500,
            silenceThreshold: options.silenceThreshold ?? 0.01,
            maxDuration: options.maxDuration ?? 300000,
          });
        }
        logger.logTrace({
          channel: 'media',
          event: 'media.playback.stopped',
          summary: 'Audio capture stopped',
          data: {
            durationMs: Math.round(capture.durationMs),
            samples: capture.left.length,
          },
        });

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
        }

        if (globalOptions.format === 'json') {
          const jsonResult = {
            success: true,
            durationMs: Math.round(capture.durationMs),
            sampleRate: capture.sampleRate,
            samples: capture.left.length,
            chunks: capture.chunkCount,
            ...(options.out ? { file: options.out } : {}),
            ...(transcript !== undefined ? { transcript } : {}),
          };
          output(jsonResult, 'json');
        } else {
          const hasAudio = capture.left.length > 0;
          const lines: string[] = ['Audio Capture Complete'];
          if (hasAudio) {
            lines.push(
              `  Duration: ${formatMs(capture.durationMs)} of audio (${capture.chunkCount} chunks)`
            );
            if (options.out) lines.push(`  Saved:    ${options.out}`);
            if (transcript !== undefined) lines.push(`  Transcript: "${transcript}"`);
          } else {
            lines.push('  Result:   no audio detected');
          }
          console.log(lines.join('\n'));
        }
        break;
      }

      case 'roundtrip': {
        if (!options.input) {
          throw new Error(
            '--input / -i is required for roundtrip. Usage: bp audio roundtrip -i prompt.wav'
          );
        }

        const audioData = await readInputFile(options.input);
        const inputSizeBytes = await getFileSize(options.input);
        console.log(
          `Round-trip: playing ${options.input} (${formatBytes(inputSizeBytes)}), waiting for response...`
        );

        if (options.verbose) {
          const startTime = Date.now();
          page.audioOutput.onDiag((msg) => {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`  [${elapsed}s] ${msg}`);
          });
        }

        const result = await page.audioRoundTrip({
          input: audioData,
          silenceTimeout: options.silenceTimeout ?? 1500,
          silenceThreshold: options.silenceThreshold,
          timeout: options.timeout ?? 120000,
          preDelay: options.preDelay,
          sendSelector: options.sendSelector,
        });
        logger.logTrace({
          channel: 'voice',
          event: 'voice.capture.started',
          summary: 'Voice roundtrip started',
          data: { file: options.input },
        });

        let savedFile: string | undefined;
        if (options.out) {
          if (result.audio.left.length === 0) {
            console.log('Warning: no audio captured, writing empty WAV');
          }
          const wav = pcmToWav({
            left: result.audio.left,
            right: result.audio.right.length > 0 ? result.audio.right : undefined,
            sampleRate: result.audio.sampleRate,
          });
          await writeWavFile(options.out, wav);
          savedFile = options.out;
        }

        let transcript: string | undefined;
        if (options.doTranscribe && result.audio.left.length > 0) {
          console.log('Transcribing response...');
          const tr = await transcribe(result.audio, { language: options.language });
          transcript = tr.text;
        }

        const hasResponse = result.latencyMs !== -1 && result.audio.left.length > 0;
        logger.logTrace({
          channel: hasResponse ? 'voice' : 'media',
          event: hasResponse ? 'voice.capture.detectedAudio' : 'voice.pipeline.notReady',
          severity: hasResponse ? 'info' : 'error',
          summary: hasResponse ? 'Voice response captured' : 'Voice response missing',
          data: {
            latencyMs: result.latencyMs,
            durationMs: Math.round(result.audio.durationMs),
            samples: result.audio.left.length,
          },
        });

        if (globalOptions.format === 'json') {
          const jsonResult = {
            success: true,
            input: {
              file: basename(options.input),
              sizeBytes: inputSizeBytes,
            },
            latencyMs: result.latencyMs,
            totalMs: result.totalMs,
            response: {
              durationMs: Math.round(result.audio.durationMs),
              sampleRate: result.audio.sampleRate,
              samples: result.audio.left.length,
              chunks: result.audio.chunkCount,
              ...(savedFile ? { file: savedFile } : {}),
            },
            ...(transcript !== undefined ? { transcript } : {}),
          };
          output(jsonResult, 'json');
        } else {
          const inputName = basename(options.input);
          const inputDurLabel = formatBytes(inputSizeBytes);

          const lines: string[] = ['Voice Roundtrip Complete'];
          lines.push(`  Input:    ${inputName} (${inputDurLabel})`);

          if (hasResponse) {
            lines.push(`  Latency:  ${formatMs(result.latencyMs)} (time to first response)`);
            lines.push(
              `  Response: ${formatMs(result.audio.durationMs)} of audio (${result.audio.chunkCount} chunks)`
            );
            lines.push(`  Total:    ${formatMs(result.totalMs)}`);
            if (savedFile) lines.push(`  Saved:    ${savedFile}`);
            if (transcript !== undefined) lines.push(`  Transcript: "${transcript}"`);
          } else {
            lines.push('  Response: no audio detected');
            lines.push(`  Total:    ${formatMs(result.totalMs)}`);
            lines.push("  Warning:  Agent did not respond. Run 'bp audio check' to diagnose.");
          }

          console.log(lines.join('\n'));
        }
        break;
      }

      default:
        throw new Error(
          `Unknown audio subcommand: ${options.subcommand}\n` +
            'Available: setup, play, capture, roundtrip, check'
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
