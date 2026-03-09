/**
 * Record command - Record browser actions to JSON
 *
 * Captures human interactions in a browser session and saves them
 * as JSON steps compatible with page.batch() for replay.
 */

import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Browser, connect, getBrowserWebSocketUrl } from '../../index.ts';
import type { RecordingFrame, RecordingManifest } from '../../recording/manifest.ts';
import type {
  ListenMode,
  RecorderListenOptions,
  RecorderOptions,
} from '../../recording/recorder.ts';
import { Recorder } from '../../recording/recorder.ts';
import { redactValueForRecording } from '../../recording/redaction.ts';
import type { RawRecordedEvent } from '../../recording/types.ts';
import { output } from '../index.ts';
import {
  generateSessionId,
  getDefaultSession,
  loadSession,
  type RecordSettings,
  type SessionData,
  saveSession,
  updateSession,
} from '../session.ts';

const RECORD_HELP = `
bp record - Record browser actions to JSON

Usage:
  bp record [options]

Options:
  -s, --session [id]  Session to use:
                        - omit -s: auto-connect to local browser
                        - -s alone: use most recent session
                        - -s <id>: use specific session
  -f, --file <path>   Output file (default: recording.json)
  --timeout <ms>      Auto-stop after timeout (optional)
  --listen [mode]     Capture network traffic: ws, http, or all (default: all)
  --bodies            Capture HTTP response bodies (requires --listen)
  -m, --match <glob>  Filter network URLs by glob pattern (requires --listen)
  --max-payload <n>   Max WebSocket payload preview length (default: 256)
  -h, --help          Show this help

Examples:
  bp record                              # Auto-connect to local Chrome
  bp record -s                           # Use most recent session
  bp record -s mysession                 # Use specific session
  bp record -f login.json                # Save to specific file
  bp record --timeout 60000              # Auto-stop after 60s
  bp record --listen                     # Record actions + all network traffic
  bp record --listen ws -m "*voice*"     # Record actions + matching WS traffic
  bp record --listen http --bodies       # Record actions + HTTP with bodies

Recording captures: clicks, inputs, form submissions, navigation.
Screenshots are captured automatically after each interaction and saved
to the session directory (~/.browser-pilot/sessions/<id>/screenshots/).
When --listen is enabled, network traffic is captured alongside actions
and merged into a unified timeline in the output file.
Sensitive fields are automatically redacted as [REDACTED] based on the
field settings (password, hidden, one-time-code, card autofill hints).
Recording also enables session-level auto-recording for subsequent
bp exec calls (equivalent to bp connect --record).

Press Ctrl+C to stop recording and save.
`;

interface RecordOptions {
  file?: string;
  timeout?: number;
  help?: boolean;
  useLatestSession?: boolean;
  listen?: boolean | ListenMode;
  bodies?: boolean;
  match?: string;
  maxPayload?: number;
}

export function parseRecordArgs(args: string[]): RecordOptions {
  const options: RecordOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '-f' || arg === '--file') {
      options.file = args[++i];
    } else if (arg === '--timeout') {
      options.timeout = Number.parseInt(args[++i] ?? '', 10);
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-s' || arg === '--session') {
      // Check if next arg is a value or another flag (or end of args)
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('-')) {
        options.useLatestSession = true;
      }
      // Note: actual session ID value is parsed by main CLI into globalOptions.session
    } else if (arg === '--listen') {
      // Check if next arg is a mode value
      const nextArg = args[i + 1];
      if (nextArg && (nextArg === 'ws' || nextArg === 'http' || nextArg === 'all')) {
        options.listen = nextArg as ListenMode;
        i++;
      } else {
        options.listen = true;
      }
    } else if (arg === '--bodies') {
      options.bodies = true;
    } else if (arg === '-m' || arg === '--match') {
      options.match = args[++i];
    } else if (arg === '--max-payload') {
      options.maxPayload = Number.parseInt(args[++i] ?? '', 10);
    }
  }

  return options;
}

interface ResolvedConnection {
  browser: Browser;
  session: SessionData;
  isNewSession: boolean;
}

/**
 * Resolve which browser connection to use based on arguments.
 *
 * Three modes:
 * 1. sessionId provided -> use that specific session
 * 2. useLatestSession -> use most recent session
 * 3. neither -> auto-connect to local browser and create new session
 */
async function resolveConnection(
  sessionId: string | undefined,
  useLatestSession: boolean,
  trace: boolean
): Promise<ResolvedConnection> {
  // Mode 1: Specific session ID provided
  if (sessionId) {
    const session = await loadSession(sessionId);
    const browser = await connect({
      provider: session.provider,
      wsUrl: session.wsUrl,
      debug: trace,
    });
    return { browser, session, isNewSession: false };
  }

  // Mode 2: Use latest session (-s flag without value)
  if (useLatestSession) {
    const session = await getDefaultSession();
    if (!session) {
      throw new Error(
        'No sessions found. Run "bp connect" first or use "bp record" to auto-connect.'
      );
    }
    const browser = await connect({
      provider: session.provider,
      wsUrl: session.wsUrl,
      debug: trace,
    });
    return { browser, session, isNewSession: false };
  }

  // Mode 3: Auto-connect to local browser (no -s flag at all)
  let wsUrl: string;
  try {
    wsUrl = await getBrowserWebSocketUrl('localhost:9222');
  } catch {
    throw new Error(
      'Could not auto-discover browser.\n' +
        'Either:\n' +
        '  1. Start Chrome with: --remote-debugging-port=9222\n' +
        '  2. Use an existing session: bp record -s <session-id>\n' +
        '  3. Use latest session: bp record -s'
    );
  }

  const browser = await connect({
    provider: 'generic',
    wsUrl,
    debug: trace,
  });

  // Create and save new session
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

export async function recordCommand(
  args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  const options = parseRecordArgs(args);

  // Show help if requested
  if (options.help || globalOptions.help) {
    console.log(RECORD_HELP);
    return;
  }

  // Default output file
  const outputFile = options.file ?? 'recording.json';

  // Resolve connection (auto-connect, latest session, or specific session)
  const { browser, session, isNewSession } = await resolveConnection(
    globalOptions.session,
    options.useLatestSession ?? false,
    globalOptions.trace ?? false
  );

  if (isNewSession) {
    console.log(`Created new session: ${session.id}`);
  }

  // Enable session-level recording so replaying captured steps auto-records screenshots
  if (!session.metadata?.record) {
    const recordSettings: RecordSettings = {};
    await updateSession(session.id, { metadata: { record: recordSettings } });
  }

  const page = await browser.page();
  const cdp = page.cdpClient;

  // Build recorder options
  let listenConfig: RecorderListenOptions | boolean | undefined;
  if (options.listen) {
    const listenOpts: RecorderListenOptions = {
      mode: typeof options.listen === 'string' ? options.listen : 'all',
      match: options.match,
      captureResponseBodies: options.bodies,
      maxPayload: options.maxPayload,
    };
    listenConfig = listenOpts;
  }

  // Set up screenshot capture directory (accumulative with existing frames)
  const sessionDir = join(homedir(), '.browser-pilot', 'sessions', session.id);
  const screenshotDir = join(sessionDir, 'screenshots');
  const manifestPath = join(sessionDir, 'recording.json');
  nodeFs.mkdirSync(screenshotDir, { recursive: true });

  // Load existing frames for accumulative recording
  const recordingFrames: RecordingFrame[] = [];
  let manifestRecordedAt = new Date().toISOString();
  let manifestStartUrl = '';
  try {
    const existing = JSON.parse(nodeFs.readFileSync(manifestPath, 'utf-8')) as RecordingManifest;
    if (existing.frames && Array.isArray(existing.frames)) {
      recordingFrames.push(...existing.frames);
    }
    if (existing.recordedAt) manifestRecordedAt = existing.recordedAt;
    if (existing.startUrl) manifestStartUrl = existing.startUrl;
  } catch {
    // No existing manifest — start fresh
  }

  const recordFormat = session.metadata?.record?.format ?? 'webp';
  const recordQuality = session.metadata?.record?.quality ?? 40;
  let screenshotCount = 0;

  // Map recorder event kinds to action-type-like labels for filenames
  function eventKindLabel(kind: string): string {
    switch (kind) {
      case 'click':
      case 'dblclick':
        return 'click';
      case 'input':
      case 'change':
        return 'fill';
      case 'submit':
        return 'submit';
      case 'keydown':
        return 'press';
      case 'navigation':
        return 'goto';
      default:
        return kind;
    }
  }

  // Screenshot capture callback for each recorded event
  async function captureScreenshotForEvent(event: RawRecordedEvent): Promise<void> {
    try {
      const ts = Date.now();
      const seq = String(recordingFrames.length + 1).padStart(4, '0');
      const label = eventKindLabel(event.kind);
      const filename = `${seq}-${ts}-${label}.${recordFormat}`;
      const filepath = join(screenshotDir, filename);

      // Take screenshot via CDP directly (page may not have screenshot method here)
      const result = await cdp.send<{ data: string }>('Page.captureScreenshot', {
        format: recordFormat === 'png' ? 'png' : recordFormat === 'jpeg' ? 'jpeg' : 'webp',
        quality: recordFormat === 'png' ? undefined : recordQuality,
      });
      const buffer = Buffer.from(result.data, 'base64');
      nodeFs.writeFileSync(filepath, buffer);

      // Get page info
      let pageUrl: string | undefined;
      let pageTitle: string | undefined;
      try {
        const urlResult = await cdp.send<{ result: { value: string } }>('Runtime.evaluate', {
          expression: 'location.href',
          returnByValue: true,
        });
        pageUrl = urlResult.result.value;
        const titleResult = await cdp.send<{ result: { value: string } }>('Runtime.evaluate', {
          expression: 'document.title',
          returnByValue: true,
        });
        pageTitle = titleResult.result.value;
      } catch {
        /* best-effort */
      }

      // Build target metadata from event element info for redaction
      const targetMetadata = event.element
        ? {
            tagName: event.element.tag,
            inputType: event.element.type ?? undefined,
          }
        : undefined;

      const frame: RecordingFrame = {
        seq: recordingFrames.length + 1,
        timestamp: ts,
        action: label as RecordingFrame['action'],
        selector: event.selectors?.[0]?.selector,
        value: redactValueForRecording(event.value, targetMetadata),
        coordinates: event.client,
        success: true,
        durationMs: 0,
        screenshot: `screenshots/${filename}`,
        pageUrl,
        pageTitle,
      };

      recordingFrames.push(frame);
      screenshotCount++;
    } catch {
      /* Screenshot capture is best-effort */
    }
  }

  // Create recorder with screenshot callback
  const recorderOptions: RecorderOptions = {
    ...(listenConfig ? { listen: listenConfig } : {}),
    onEvent: captureScreenshotForEvent,
  };
  const recorder = new Recorder(cdp, recorderOptions);

  // Track if we're already stopping to prevent double-stop
  let stopping = false;

  // Stop recording and save
  async function stopAndSave(): Promise<void> {
    if (stopping) return;
    stopping = true;

    try {
      const recording = await recorder.stop();

      // Write action steps to output file
      const fs = await import('node:fs/promises');
      await fs.writeFile(outputFile, JSON.stringify(recording, null, 2));

      // Write screenshot manifest (accumulative)
      let currentUrl = '';
      let viewport = { width: 1280, height: 720 };
      try {
        const urlResult = await cdp.send<{ result: { value: string } }>('Runtime.evaluate', {
          expression: 'location.href',
          returnByValue: true,
        });
        currentUrl = urlResult.result.value;
      } catch {
        /* best-effort */
      }
      try {
        const metrics = await cdp.send<{
          cssVisualViewport: { clientWidth: number; clientHeight: number };
        }>('Page.getLayoutMetrics');
        viewport = {
          width: metrics.cssVisualViewport.clientWidth,
          height: metrics.cssVisualViewport.clientHeight,
        };
      } catch {
        /* use default */
      }

      const manifest: RecordingManifest = {
        version: 1,
        recordedAt: manifestRecordedAt,
        sessionId: session.id,
        startUrl: manifestStartUrl || recording.startUrl,
        endUrl: currentUrl,
        viewport,
        format: recordFormat,
        quality: recordQuality,
        totalDurationMs: recording.duration,
        success: true,
        frames: recordingFrames,
      };
      nodeFs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      // Update session
      await updateSession(session.id, { currentUrl: currentUrl || recording.startUrl });

      // Disconnect
      await browser.disconnect();

      // Output summary
      const networkInfo = recording.network
        ? `, ${recording.network.requests.length} HTTP requests`
        : '';
      const wsInfo = recording.websockets
        ? `, ${recording.websockets.frames.length} WS frames`
        : '';
      const timelineInfo = recording.timeline
        ? ` (${recording.timeline.length} timeline entries)`
        : '';
      const screenshotInfo = screenshotCount > 0 ? `, ${screenshotCount} screenshots` : '';
      console.log(
        `\nSaved ${recording.steps.length} steps${screenshotInfo}${networkInfo}${wsInfo}${timelineInfo} to ${outputFile}`
      );
      if (screenshotCount > 0) {
        console.log(`Screenshots: ${sessionDir}`);
      }

      if (globalOptions.format === 'json') {
        output(
          {
            success: true,
            file: outputFile,
            steps: recording.steps.length,
            screenshots: screenshotCount,
            duration: recording.duration,
            networkRequests: recording.network?.requests.length ?? 0,
            wsFrames: recording.websockets?.frames.length ?? 0,
            timelineEntries: recording.timeline?.length ?? 0,
          },
          'json'
        );
      }

      process.exit(0);
    } catch (error) {
      console.error('Error saving recording:', error);
      process.exit(1);
    }
  }

  // Handle signals
  const handleSignal = () => {
    stopAndSave().catch((err) => {
      console.error('Error during shutdown:', err);
      process.exit(1);
    });
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  // Handle timeout
  if (options.timeout && options.timeout > 0) {
    setTimeout(() => {
      void stopAndSave();
    }, options.timeout);
  }

  // Start recording
  await recorder.start();

  console.log(`Recording... Press Ctrl+C to stop and save to ${outputFile}`);
  if (options.listen) {
    const listenMode = typeof options.listen === 'string' ? options.listen : 'all';
    const matchLabel = options.match ? ` matching "${options.match}"` : '';
    console.log(`Network capture: ${listenMode} traffic${matchLabel}`);
  }
  console.log(`Session: ${session.id}`);
  console.log(`URL: ${await page.url()}`);
}
