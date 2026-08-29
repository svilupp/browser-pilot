import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalizeRecordingArtifact } from '../../recording/manifest.ts';
import {
  type BackgroundTraceState,
  backgroundTraceStopRequested,
  clearBackgroundTraceStop,
  createCaptureId,
  DEFAULT_BACKGROUND_TRACE_MAX_BYTES,
  DEFAULT_BACKGROUND_TRACE_TIMEOUT_MS,
  getBackgroundTracePaths,
  isBackgroundTraceActive,
  isProcessAlive,
  readBackgroundTraceState,
  requestBackgroundTraceStop,
  updateBackgroundTraceState,
  writeBackgroundTraceState,
} from '../../trace/background.ts';
import { type ListenMode, LiveTraceCollector } from '../../trace/live.ts';
import type { CanonicalTraceEvent, TraceView } from '../../trace/model.ts';
import { getSessionTracePath, readTraceEvents } from '../../trace/store.ts';
import { buildTraceSummaries, buildTraceSummary } from '../../trace/views.ts';
import { attachSession, resolveSession } from '../attach.ts';
import { output } from '../output.ts';
import { getDefaultSession, loadSession } from '../session.ts';

const TRACE_HELP = `
bp trace - Inspect, summarize, and watch behavior over time

When to use:
  The question spans time, causality, network, console, permissions, media, or voice state.

When not to use:
  You already know the target element and just need to click, fill, or assert DOM state once. Use \`bp exec\`.

Capture modes:
  Foreground/blocking:  \`bp trace start\` stays attached until Ctrl+C or --timeout.
  Background/non-blocking: \`bp trace start --background\` returns immediately.
  Background captures auto-stop after 10 minutes or 100 MB by default.

Common mistake:
  Using \`trace\` as the primary action surface. It analyzes behavior; it does not replace \`exec\` or \`run\`.

Usage:
  bp trace <start|status|stop|tail|summary|watch|export|merge> [artifact|trace.jsonl] [options]

Commands:
  start                 Capture live events; blocks unless --background is used
  status                Show the current/recent background capture
  stop                  Ask the background capture to stop cleanly
  tail                  Stream live canonical events (listen compatibility surface)
  summary               Summarize a session trace or saved artifact
  watch                 Run a durable trace assertion over a live capture window
  export                Export events + summary to JSON
  merge                 Merge multiple artifacts or trace files

Options:
  -s, --session [id]    Session to use (omit: default session, -s: latest, -s <id>: specific)
  --view <name>         http | ws | voice | console | permissions | media | ui | session
  -m, --match <glob>    Filter HTTP/WS URLs for live capture
  -o, --output <path>   Output file for start/export/merge
  --timeout <ms>        Stop live capture or watch after timeout
  --background          Run start detached (alias: --detach; default timeout: 10 minutes)
  --max-mb <n>          Per-capture storage cap (background default: 100 MB)
  --max-payload <n>     Max WebSocket payload preview length (default: 256)
  --assert <name>       Watch assertion (profile:reconnect, no-console-errors)
  -q, --quiet           Suppress status lines for live capture
  -h, --help            Show help

Examples:
  bp trace start -s dev --timeout 30000          # blocks for up to 30s
  bp trace start -s dev --background             # returns; auto-stops after 10m/100 MB
  bp trace status -s dev
  bp trace stop -s dev
  bp trace summary -s dev --view http
  bp trace tail ws -m "*realtime*"
  bp trace summary -s dev --view session
  bp trace summary recording.json --view ws
  bp trace watch -s dev --view ws --assert profile:reconnect --timeout 15000
  bp trace watch -s dev --view console --assert no-console-errors --timeout 5000
  bp trace export -s dev -o trace-bundle.json
  bp trace merge trace-a.jsonl trace-b.jsonl -o merged-trace.json

Likely next commands:
  bp trace summary -s dev --view ws
  bp trace summary -s dev --view voice
  bp trace export -s dev -o trace-bundle.json
`.trim();

interface TraceOptions {
  subcommand?: 'start' | 'status' | 'stop' | 'tail' | 'summary' | 'watch' | 'export' | 'merge';
  source?: string;
  sources: string[];
  output?: string;
  timeout?: number;
  view?: TraceView;
  assert?: string;
  match?: string;
  maxPayload?: number;
  maxBytes?: number;
  background?: boolean;
  backgroundWorker?: string;
  quiet?: boolean;
  help?: boolean;
  mode?: ListenMode;
  useLatestSession?: boolean;
}

export function parseTraceArgs(args: string[]): TraceOptions {
  const options: TraceOptions = { sources: [], view: 'session' };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (
      !options.subcommand &&
      (arg === 'start' ||
        arg === 'status' ||
        arg === 'stop' ||
        arg === 'tail' ||
        arg === 'summary' ||
        arg === 'watch' ||
        arg === 'export' ||
        arg === 'merge')
    ) {
      options.subcommand = arg;
      continue;
    }

    if (!options.subcommand && (arg === 'ws' || arg === 'http' || arg === 'all')) {
      options.subcommand = 'tail';
      options.mode = arg;
      continue;
    }

    if (arg === '-o' || arg === '--output') {
      options.output = args[++i];
    } else if (arg === '--timeout') {
      options.timeout = Number.parseInt(args[++i] ?? '', 10);
      if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
        throw new Error('--timeout must be a positive number of milliseconds');
      }
    } else if (arg === '--background' || arg === '--detach') {
      options.background = true;
    } else if (arg === '--background-worker') {
      options.backgroundWorker = args[++i];
    } else if (arg === '--max-mb') {
      const maxMb = Number.parseFloat(args[++i] ?? '');
      if (!Number.isFinite(maxMb) || maxMb <= 0) {
        throw new Error('--max-mb must be a positive number');
      }
      options.maxBytes = Math.floor(maxMb * 1024 * 1024);
    } else if (arg === '--view') {
      const view = args[++i];
      if (
        view === 'http' ||
        view === 'ws' ||
        view === 'voice' ||
        view === 'console' ||
        view === 'permissions' ||
        view === 'media' ||
        view === 'ui' ||
        view === 'session'
      ) {
        options.view = view;
      } else {
        throw new Error(
          `Unsupported trace view: ${view ?? '(missing)'}. Expected http, ws, voice, console, permissions, media, ui, or session.`
        );
      }
    } else if (arg === '--assert') {
      options.assert = args[++i];
    } else if (arg === '-m' || arg === '--match') {
      options.match = args[++i];
    } else if (arg === '--max-payload') {
      options.maxPayload = Number.parseInt(args[++i] ?? '', 10);
    } else if (arg === '-q' || arg === '--quiet') {
      options.quiet = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-s' || arg === '--session') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('-')) {
        options.useLatestSession = true;
      }
    } else if (arg === 'ws' || arg === 'http' || arg === 'all') {
      options.mode = arg;
    } else if (!arg.startsWith('-')) {
      if (!options.source) {
        options.source = arg;
      }
      options.sources.push(arg);
    }
  }

  options.subcommand ??= 'summary';
  return options;
}

async function resolveTraceSource(
  sourceHint: string | undefined,
  sessionId: string | undefined
): Promise<{ path: string; events: CanonicalTraceEvent[] }> {
  if (sourceHint && fs.existsSync(sourceHint)) {
    if (sourceHint.endsWith('.jsonl')) {
      return { path: resolve(sourceHint), events: readTraceEvents(sourceHint) };
    }

    const raw = JSON.parse(fs.readFileSync(sourceHint, 'utf-8')) as unknown;
    const artifact = canonicalizeRecordingArtifact(raw);
    return { path: resolve(sourceHint), events: artifact.trace.events };
  }

  let session = null;
  if (sessionId) {
    session = await loadSession(sessionId);
  } else {
    session = await getDefaultSession();
  }

  if (!session) {
    throw new Error('No session found. Run "bp connect" first or pass an artifact path.');
  }

  const tracePath = getSessionTracePath(session.id);
  if (fs.existsSync(tracePath)) {
    return { path: tracePath, events: readTraceEvents(tracePath) };
  }

  const artifactPath = resolve(getSessionTracePath(session.id), '..', 'recording.json');
  if (fs.existsSync(artifactPath)) {
    const raw = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as unknown;
    const artifact = canonicalizeRecordingArtifact(raw);
    return { path: artifactPath, events: artifact.trace.events };
  }

  return { path: tracePath, events: [] };
}

async function runLiveTrace(
  sessionId: string | undefined,
  options: TraceOptions,
  debug: boolean,
  mode: 'start' | 'tail' | 'watch',
  lifecycle: { onStarted?: () => void } = {}
): Promise<{
  events: CanonicalTraceEvent[];
  bytesWritten: number;
  stopReason: 'signal' | 'timeout' | 'requested' | 'size_limit';
}> {
  const session = await resolveSession(sessionId);
  const { browser, page } = await attachSession(session, { trace: debug });
  const tracePath = getSessionTracePath(session.id);
  fs.mkdirSync(dirname(tracePath), { recursive: true });

  const sinkPath = options.output ? resolve(options.output) : tracePath;
  fs.mkdirSync(dirname(sinkPath), { recursive: true });
  const liveEvents: CanonicalTraceEvent[] = [];
  const outputIsTracePath = resolve(sinkPath) === resolve(tracePath);
  let bytesWritten = 0;
  let stopReason: 'signal' | 'timeout' | 'requested' | 'size_limit' = 'signal';
  let stopped = false;
  let resolveStop!: () => void;
  const stopPromise = new Promise<void>((resolvePromise) => {
    resolveStop = resolvePromise;
  });
  const stop = (reason: typeof stopReason) => {
    if (stopped) return;
    stopped = true;
    stopReason = reason;
    resolveStop();
  };
  const signalStop = () => stop('signal');
  process.once('SIGINT', signalStop);
  process.once('SIGTERM', signalStop);
  const timeoutTimer =
    options.timeout && options.timeout > 0
      ? setTimeout(() => stop('timeout'), options.timeout)
      : undefined;
  const workerState = options.backgroundWorker ? readBackgroundTraceState(session.id) : null;
  const stopPoll =
    workerState && workerState.captureId === options.backgroundWorker
      ? setInterval(() => {
          if (backgroundTraceStopRequested(workerState.stopPath, workerState.captureId)) {
            stop('requested');
          }
        }, 250)
      : undefined;

  const collector = new LiveTraceCollector(page.cdpClient, {
    sessionId: session.id,
    targetId: page.targetId,
    mode: options.mode ?? 'all',
    match: options.match,
    maxPayload: options.maxPayload ?? 256,
    onEvent: (event) => {
      const line = `${JSON.stringify(event)}\n`;
      const lineBytes = Buffer.byteLength(line);
      const writeCopies =
        (mode !== 'tail' ? 1 : 0) + (options.output && !outputIsTracePath ? 1 : 0);
      const physicalBytes = lineBytes * writeCopies;
      if (options.maxBytes && bytesWritten + physicalBytes > options.maxBytes) {
        stop('size_limit');
        return;
      }
      liveEvents.push(event);
      bytesWritten += physicalBytes;
      if (mode !== 'tail') {
        fs.appendFileSync(tracePath, line, 'utf-8');
      }
      if (options.output && !outputIsTracePath) {
        fs.appendFileSync(sinkPath, line, 'utf-8');
      }
      if (mode === 'tail') {
        process.stdout.write(line);
      }
    },
  });

  if (!options.quiet && mode !== 'tail') {
    process.stderr.write(
      `Tracing session ${session.id} -> ${mode === 'start' ? tracePath : 'stdout'}\n`
    );
  }

  try {
    await collector.start();
    lifecycle.onStarted?.();
    await stopPromise;
    await collector.stop();
    return { events: liveEvents, bytesWritten, stopReason };
  } finally {
    process.off('SIGINT', signalStop);
    process.off('SIGTERM', signalStop);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (stopPoll) clearInterval(stopPoll);
    await browser.disconnect();
  }
}

function evaluateWatchAssertion(events: CanonicalTraceEvent[], assertion: string, view: TraceView) {
  if (assertion === 'no-console-errors') {
    const summary = buildTraceSummary(events, 'console') as { errors: number };
    return {
      ok: summary.errors === 0,
      reason:
        summary.errors === 0
          ? 'No console errors detected'
          : `${summary.errors} console/runtime errors detected`,
    };
  }

  if (assertion === 'profile:reconnect' && view === 'ws') {
    const wsEvents = events.filter((event) => event.event.startsWith('ws.'));
    const created = wsEvents.filter((event) => event.event === 'ws.connection.created');
    const closed = wsEvents.filter((event) => event.event === 'ws.connection.closed');
    const reopened = created.length > 1 || closed.length === 0;
    return {
      ok: created.length > 0 && reopened,
      reason:
        created.length === 0
          ? 'No WebSocket connections were observed'
          : reopened
            ? 'WebSocket stayed up or reconnected'
            : 'WebSocket closed without a reconnect',
    };
  }

  return {
    ok: false,
    reason: `Unsupported assertion: ${assertion}`,
  };
}

function formatBackgroundTraceState(state: BackgroundTraceState | null) {
  if (!state) {
    return { active: false, status: 'none' };
  }
  return {
    active: isBackgroundTraceActive(state),
    captureId: state.captureId,
    sessionId: state.sessionId,
    pid: state.pid,
    status: state.status,
    startedAt: state.startedAt,
    expiresAt: state.expiresAt,
    timeoutMs: state.timeoutMs,
    maxMb: Math.round((state.maxBytes / (1024 * 1024)) * 100) / 100,
    tracePath: state.tracePath,
    outputPath: state.outputPath,
    logPath: state.logPath,
    stoppedAt: state.stoppedAt,
    stopReason: state.stopReason,
    events: state.events,
    bytesWritten: state.bytesWritten,
    error: state.error,
    processAlive: isProcessAlive(state.pid),
  };
}

async function waitForBackgroundState(
  sessionId: string,
  captureId: string,
  accept: (state: BackgroundTraceState) => boolean,
  timeoutMs = 5000
): Promise<BackgroundTraceState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readBackgroundTraceState(sessionId);
    if (state?.captureId === captureId && accept(state)) return state;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const state = readBackgroundTraceState(sessionId);
  return state?.captureId === captureId ? state : null;
}

async function startBackgroundTrace(
  options: TraceOptions,
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean }
): Promise<void> {
  const session = await resolveSession(globalOptions.session);
  const existing = readBackgroundTraceState(session.id);
  if (isBackgroundTraceActive(existing)) {
    throw new Error(
      `A background trace is already ${existing!.status} for session ${session.id}. ` +
        `Run "bp trace status -s ${session.id}" or "bp trace stop -s ${session.id}".`
    );
  }

  const timeoutMs = options.timeout ?? DEFAULT_BACKGROUND_TRACE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_BACKGROUND_TRACE_MAX_BYTES;
  const captureId = createCaptureId();
  const startedAt = new Date();
  const { stopPath, logPath } = getBackgroundTracePaths(session.id);
  clearBackgroundTraceStop(session.id);
  fs.mkdirSync(dirname(logPath), { recursive: true });

  const initialState: BackgroundTraceState = {
    schemaVersion: 1,
    captureId,
    sessionId: session.id,
    pid: 0,
    status: 'starting',
    startedAt: startedAt.toISOString(),
    updatedAt: startedAt.toISOString(),
    expiresAt: new Date(startedAt.getTime() + timeoutMs).toISOString(),
    timeoutMs,
    maxBytes,
    tracePath: getSessionTracePath(session.id),
    ...(options.output ? { outputPath: resolve(options.output) } : {}),
    logPath,
    stopPath,
  };
  writeBackgroundTraceState(initialState);

  const cliEntry = process.argv[1] ? resolve(process.argv[1]) : undefined;
  if (!cliEntry || !fs.existsSync(cliEntry)) {
    updateBackgroundTraceState(session.id, captureId, {
      status: 'failed',
      error: 'Could not resolve the browser-pilot CLI entry point for background capture',
    });
    throw new Error('Could not resolve the browser-pilot CLI entry point for background capture');
  }

  const childArgs = [
    cliEntry,
    'trace',
    'start',
    '--background-worker',
    captureId,
    '--timeout',
    String(timeoutMs),
    '--max-mb',
    String(maxBytes / (1024 * 1024)),
    '--quiet',
    '-s',
    session.id,
  ];
  if (options.output) childArgs.push('--output', resolve(options.output));
  if (options.match) childArgs.push('--match', options.match);
  if (options.maxPayload) childArgs.push('--max-payload', String(options.maxPayload));
  if (options.mode) childArgs.push(options.mode);
  if (globalOptions.trace) childArgs.push('--debug');

  const logFd = fs.openSync(logPath, 'w');
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    env: process.env,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  child.unref();
  if (!child.pid) {
    updateBackgroundTraceState(session.id, captureId, {
      status: 'failed',
      error: 'Failed to spawn background trace process',
    });
    throw new Error('Failed to spawn background trace process');
  }

  updateBackgroundTraceState(session.id, captureId, { pid: child.pid });
  const state = await waitForBackgroundState(
    session.id,
    captureId,
    (candidate) => candidate.status !== 'starting',
    5000
  );
  if (state?.status === 'failed') {
    throw new Error(`Background trace failed to start: ${state.error ?? `see ${state.logPath}`}`);
  }
  if (!state || state.status !== 'running' || !isProcessAlive(state.pid)) {
    throw new Error(`Background trace did not become ready; see ${logPath}`);
  }

  output(formatBackgroundTraceState(state), globalOptions.format ?? 'pretty');
}

async function runBackgroundTraceWorker(
  options: TraceOptions,
  globalOptions: { session?: string; trace?: boolean }
): Promise<void> {
  const session = await resolveSession(globalOptions.session);
  const captureId = options.backgroundWorker!;
  const registered = await waitForBackgroundState(
    session.id,
    captureId,
    (state) => state.pid === process.pid,
    5000
  );
  if (!registered || registered.pid !== process.pid) {
    throw new Error('Background trace worker was not registered by its parent process');
  }

  try {
    const result = await runLiveTrace(session.id, options, globalOptions.trace ?? false, 'start', {
      onStarted: () => {
        updateBackgroundTraceState(session.id, captureId, { status: 'running' });
      },
    });
    updateBackgroundTraceState(session.id, captureId, {
      status: 'stopped',
      stoppedAt: new Date().toISOString(),
      stopReason: result.stopReason,
      events: result.events.length,
      bytesWritten: result.bytesWritten,
    });
  } catch (error) {
    updateBackgroundTraceState(session.id, captureId, {
      status: 'failed',
      stoppedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    clearBackgroundTraceStop(session.id);
  }
}

async function traceStatus(globalOptions: {
  session?: string;
  format?: 'json' | 'pretty';
}): Promise<void> {
  const session = await resolveSession(globalOptions.session);
  output(
    formatBackgroundTraceState(readBackgroundTraceState(session.id)),
    globalOptions.format ?? 'pretty'
  );
}

async function traceStop(globalOptions: {
  session?: string;
  format?: 'json' | 'pretty';
}): Promise<void> {
  const session = await resolveSession(globalOptions.session);
  const state = readBackgroundTraceState(session.id);
  if (!state || !isBackgroundTraceActive(state)) {
    output(formatBackgroundTraceState(state), globalOptions.format ?? 'pretty');
    return;
  }

  requestBackgroundTraceStop(state);
  updateBackgroundTraceState(session.id, state.captureId, { status: 'stopping' });
  const stopped = await waitForBackgroundState(
    session.id,
    state.captureId,
    (candidate) => candidate.status === 'stopped' || candidate.status === 'failed',
    5000
  );
  output(formatBackgroundTraceState(stopped), globalOptions.format ?? 'pretty');
}

async function traceStart(
  options: TraceOptions,
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean }
): Promise<void> {
  if (options.background) {
    await startBackgroundTrace(options, globalOptions);
    return;
  }
  if (options.backgroundWorker) {
    await runBackgroundTraceWorker(options, globalOptions);
    return;
  }
  if (!options.quiet) {
    process.stderr.write(
      'Foreground trace capture is blocking; stop with Ctrl+C or --timeout. ' +
        'Use --background to return immediately.\n'
    );
  }
  const result = await runLiveTrace(
    globalOptions.session,
    options,
    globalOptions.trace ?? false,
    'start'
  );
  output(
    {
      success: true,
      events: result.events.length,
      bytesWritten: result.bytesWritten,
      stopReason: result.stopReason,
      output: getSessionTracePath((await resolveSession(globalOptions.session)).id),
    },
    globalOptions.format ?? 'pretty'
  );
}

async function traceTail(
  options: TraceOptions,
  globalOptions: { session?: string; trace?: boolean }
): Promise<void> {
  await runLiveTrace(globalOptions.session, options, globalOptions.trace ?? false, 'tail');
}

async function traceSummary(
  options: TraceOptions,
  globalOptions: { session?: string; format?: 'json' | 'pretty' }
): Promise<void> {
  const source = await resolveTraceSource(options.source, globalOptions.session);
  const filtered =
    options.mode === 'ws'
      ? source.events.filter((event) => event.channel === 'ws')
      : options.mode === 'http'
        ? source.events.filter((event) => event.channel === 'http')
        : source.events;
  const summary = buildTraceSummary(filtered, options.view ?? 'session');
  output(
    {
      source: source.path,
      view: options.view ?? 'session',
      summary,
    },
    globalOptions.format ?? 'pretty'
  );
}

async function traceWatch(
  options: TraceOptions,
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean }
): Promise<void> {
  const view = options.view ?? 'session';
  const events = options.source
    ? (await resolveTraceSource(options.source, globalOptions.session)).events
    : (await runLiveTrace(globalOptions.session, options, globalOptions.trace ?? false, 'watch'))
        .events;

  const assertion = options.assert ?? (view === 'ws' ? 'profile:reconnect' : 'no-console-errors');
  const result = evaluateWatchAssertion(events, assertion, view);

  if (!result.ok) {
    throw new Error(result.reason);
  }

  output(
    {
      success: true,
      assertion,
      reason: result.reason,
      summary: buildTraceSummary(events, view),
    },
    globalOptions.format ?? 'pretty'
  );
}

async function traceExport(
  options: TraceOptions,
  globalOptions: { session?: string; format?: 'json' | 'pretty' }
): Promise<void> {
  if (!options.output) {
    throw new Error('trace export requires -o <output.json>');
  }

  const source = await resolveTraceSource(options.source, globalOptions.session);
  const payload = {
    source: source.path,
    exportedAt: new Date().toISOString(),
    summary: buildTraceSummary(source.events, options.view ?? 'session'),
    views: buildTraceSummaries(source.events),
    events: source.events,
  };

  fs.mkdirSync(dirname(resolve(options.output)), { recursive: true });
  fs.writeFileSync(resolve(options.output), JSON.stringify(payload, null, 2));
  output({ success: true, output: resolve(options.output) }, globalOptions.format ?? 'pretty');
}

async function traceMerge(
  options: TraceOptions,
  globalOptions: { session?: string; format?: 'json' | 'pretty' }
): Promise<void> {
  if (options.sources.length === 0) {
    throw new Error('trace merge requires at least one artifact or trace file');
  }
  if (!options.output) {
    throw new Error('trace merge requires -o <output.json>');
  }

  const merged: CanonicalTraceEvent[] = [];
  for (const sourcePath of options.sources) {
    const source = await resolveTraceSource(sourcePath, globalOptions.session);
    merged.push(...source.events);
  }

  merged.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  const payload = {
    mergedAt: new Date().toISOString(),
    summary: buildTraceSummary(merged, options.view ?? 'session'),
    views: buildTraceSummaries(merged),
    events: merged,
  };

  fs.mkdirSync(dirname(resolve(options.output)), { recursive: true });
  fs.writeFileSync(resolve(options.output), JSON.stringify(payload, null, 2));
  output(
    { success: true, output: resolve(options.output), events: merged.length },
    globalOptions.format ?? 'pretty'
  );
}

export async function traceCommand(
  args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  const options = parseTraceArgs(args);

  if (options.help || globalOptions.help) {
    console.log(TRACE_HELP);
    return;
  }

  switch (options.subcommand) {
    case 'start':
      await traceStart(options, globalOptions);
      break;
    case 'status':
      await traceStatus(globalOptions);
      break;
    case 'stop':
      await traceStop(globalOptions);
      break;
    case 'tail':
      await traceTail(options, globalOptions);
      break;
    case 'summary':
      await traceSummary(options, globalOptions);
      break;
    case 'watch':
      await traceWatch(options, globalOptions);
      break;
    case 'export':
      await traceExport(options, globalOptions);
      break;
    case 'merge':
      await traceMerge(options, globalOptions);
      break;
    default:
      console.log(TRACE_HELP);
  }
}
