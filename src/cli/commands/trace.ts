import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalizeRecordingArtifact } from '../../recording/manifest.ts';
import { type ListenMode, LiveTraceCollector } from '../../trace/live.ts';
import type { CanonicalTraceEvent, TraceView } from '../../trace/model.ts';
import { getSessionTracePath, readTraceEvents } from '../../trace/store.ts';
import { buildTraceSummaries, buildTraceSummary } from '../../trace/views.ts';
import { attachSession, resolveSession } from '../attach.ts';
import { output } from '../index.ts';
import { getDefaultSession, loadSession } from '../session.ts';

const TRACE_HELP = `
bp trace - Inspect, summarize, and watch behavior over time

When to use:
  The question spans time, causality, network, console, permissions, media, or voice state.

When not to use:
  You already know the target element and just need to click, fill, or assert DOM state once. Use \`bp exec\`.

Default flow:
  start or tail live capture -> summary by view -> watch if you need a durable assertion -> export evidence

Common mistake:
  Using \`trace\` as the primary action surface. It analyzes behavior; it does not replace \`exec\` or \`run\`.

Usage:
  bp trace <start|tail|summary|watch|export|merge> [artifact|trace.jsonl] [options]

Commands:
  start                 Capture live trace events into the session trace store
  tail                  Stream live canonical events (listen compatibility surface)
  summary               Summarize a session trace or saved artifact
  watch                 Run a durable trace assertion over a live capture window
  export                Export events + summary to JSON
  merge                 Merge multiple artifacts or trace files

Options:
  -s, --session [id]    Session to use (omit: default session, -s: latest, -s <id>: specific)
  --view <name>         ws | voice | console | permissions | media | ui | session
  -m, --match <glob>    Filter HTTP/WS URLs for live capture
  -o, --output <path>   Output file for start/export/merge
  --timeout <ms>        Stop live capture or watch after timeout
  --max-payload <n>     Max WebSocket payload preview length (default: 256)
  --assert <name>       Watch assertion (profile:reconnect, no-console-errors)
  -q, --quiet           Suppress status lines for live capture
  -h, --help            Show help

Examples:
  bp trace start -s dev --timeout 30000
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
  subcommand?: 'start' | 'tail' | 'summary' | 'watch' | 'export' | 'merge';
  source?: string;
  sources: string[];
  output?: string;
  timeout?: number;
  view?: TraceView;
  assert?: string;
  match?: string;
  maxPayload?: number;
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
    } else if (arg === '--view') {
      const view = args[++i];
      if (
        view === 'ws' ||
        view === 'voice' ||
        view === 'console' ||
        view === 'permissions' ||
        view === 'media' ||
        view === 'ui' ||
        view === 'session'
      ) {
        options.view = view;
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
  mode: 'start' | 'tail' | 'watch'
): Promise<CanonicalTraceEvent[]> {
  const session = await resolveSession(sessionId);
  const { browser, page } = await attachSession(session, { trace: debug });
  const tracePath = getSessionTracePath(session.id);
  fs.mkdirSync(dirname(tracePath), { recursive: true });

  const sinkPath = options.output ? resolve(options.output) : tracePath;
  fs.mkdirSync(dirname(sinkPath), { recursive: true });
  const liveEvents: CanonicalTraceEvent[] = [];

  const collector = new LiveTraceCollector(page.cdpClient, {
    sessionId: session.id,
    targetId: page.targetId,
    mode: options.mode ?? 'all',
    match: options.match,
    maxPayload: options.maxPayload ?? 256,
    onEvent: (event) => {
      liveEvents.push(event);
      if (mode !== 'tail') {
        fs.appendFileSync(tracePath, `${JSON.stringify(event)}\n`, 'utf-8');
      }
      if (options.output) {
        fs.appendFileSync(sinkPath, `${JSON.stringify(event)}\n`, 'utf-8');
      }
      if (mode === 'tail') {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }
    },
  });

  const stopPromise = new Promise<void>((resolveStop) => {
    const stop = () => resolveStop();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    if (options.timeout && options.timeout > 0) {
      setTimeout(stop, options.timeout);
    }
  });

  if (!options.quiet && mode !== 'tail') {
    process.stderr.write(
      `Tracing session ${session.id} -> ${mode === 'start' ? tracePath : 'stdout'}\n`
    );
  }

  try {
    await collector.start();
    await stopPromise;
    return await collector.stop();
  } finally {
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

async function traceStart(
  options: TraceOptions,
  globalOptions: { session?: string; trace?: boolean }
): Promise<void> {
  const events = await runLiveTrace(
    globalOptions.session,
    options,
    globalOptions.trace ?? false,
    'start'
  );
  output(
    {
      success: true,
      events: events.length,
      output: getSessionTracePath((await resolveSession(globalOptions.session)).id),
    },
    'pretty'
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
    : await runLiveTrace(globalOptions.session, options, globalOptions.trace ?? false, 'watch');

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
