import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { Step } from '../../actions/types.ts';
import type { Browser } from '../../browser/browser.ts';
import { exportRecordingBundle, resolveRecordingImage } from '../../recording/bundle.ts';
import {
  activeRecording,
  type RecordingControlState,
  readRecordingMarkers,
  readRecordingState,
  recordingControlPaths,
  recordingStopRequested,
  requestRecordingMarker,
  requestRecordingStop,
  reserveRecording,
  writeRecordingState,
} from '../../recording/control.ts';
import {
  canonicalizeRecordingArtifact,
  createRecordingManifest,
  type RecordingFrame,
  type RecordingManifest,
} from '../../recording/manifest.ts';
import { recordingReadiness } from '../../recording/readiness.ts';
import { type ListenMode, Recorder, type RecorderListenOptions } from '../../recording/recorder.ts';
import { redactRecordingURL } from '../../recording/redaction.ts';
import type { RawRecordedEvent } from '../../recording/types.ts';
import { buildTraceSummaries } from '../../trace/views.ts';
import { attachSession, resolveSession } from '../attach.ts';
import { formatBrowserDiscoveryError, resolveCLIEndpoint } from '../browser-endpoint.ts';
import { createLocalSession } from '../connect-service.ts';
import { output } from '../output.ts';
import { getDefaultSession, loadSession, type SessionData } from '../session.ts';

type RecordProfile = 'automation' | 'realtime' | 'voice' | 'auth';
type RecordSubcommand =
  | 'capture'
  | 'inspect'
  | 'summary'
  | 'derive'
  | 'export'
  | 'bundle'
  | 'status'
  | 'stop'
  | 'marker';

const RECORD_HELP = `
bp record - Capture a human demo into one canonical artifact

When to use:
  A human is demonstrating the workflow and you want replayable automation later.

When not to use:
  You already have steps and just want to run or validate them. Use \`bp exec\` or \`bp run\`.

Default flow:
  bp connect --name demo
  bp record -s demo --profile automation -f ./artifacts/demo.recording.json
  # perform the flow, then stop with Ctrl+C
  bp record summary ./artifacts/demo.recording.json
  bp record inspect ./artifacts/demo.recording.json
  bp record derive ./artifacts/demo.recording.json -o ./artifacts/demo.workflow.json
  jq . ./artifacts/demo.workflow.json
  # review candidate steps and .readiness.json prerequisites before any replay

Common mistake:
  Opening \`recording.json\` first. Start with \`bp record summary\`.

Session and output:
  \`bp record\` captures an existing session; it does not create a named session.
  Pass \`-f <path>\` to write the captured artifact to a known filename.
  \`bp record derive\` writes browser-pilot workflow JSON, not Flightplan TOML.
  Translate the derived steps into Flightplan manually.

Usage:
  bp record [options]
  bp record <inspect|summary|derive|export> [artifact] [options]

Capture options:
  -s, --session [id]   Existing session (omit: auto-connect, -s: latest, -s <id>: specific)
  -f, --file <path>    Artifact output path (default: recording.json)
  --timeout <ms>       Auto-stop after timeout (default: 300000)
  --max-mb <n>         Bound runtime data and images (default: 50)
  --observe            Preserve viewport and session environment
  --segment <mode>     new | append (default: append)
  --screenshots <mode> off | markers | events (default: events)
  --privacy <mode>     standard | metadata (metadata requires bodies/images off)
  --navigation <mode> all | current-document (default: all)
  --drain-timeout <ms> Bound asynchronous capture drain (default: 5000)
  --background         Return after a supervised worker declares ready
  status | stop        Inspect/stop the named session recording
  marker --label <s>   Add a monotonic marker to a ready recording
  --profile <name>     automation | realtime | voice | auth (default: automation)
  --listen [mode]      ws | http | all (default: all)
  --bodies             Capture HTTP response bodies
  -m, --match <glob>   Filter HTTP/WS URLs
  --max-payload <n>    Max WebSocket payload preview length (default: 256)

Artifact subcommands:
  inspect [artifact]   Show artifact metadata and next commands
  summary [artifact]   Show workflow summary plus trace views
  derive <artifact> -o <output>   Write candidate steps and replay-readiness report
  export <artifact> -o <output>   Write JSON triage bundle with embedded images
  bundle <artifact> -o <directory> Copy a portable directory with verified image hashes

Examples:
  bp connect --name demo
  bp record -s demo --profile automation -f ./artifacts/demo.recording.json
  bp record summary ./artifacts/demo.recording.json
  bp record inspect ./artifacts/demo.recording.json
  bp record derive ./artifacts/demo.recording.json -o ./artifacts/demo.workflow.json
  bp record export ./artifacts/demo.recording.json -o ./artifacts/demo.bundle.json

Likely next commands:
  bp record summary ./artifacts/demo.recording.json
  bp trace summary ./artifacts/demo.recording.json --view ws
  bp record derive ./artifacts/demo.recording.json -o ./artifacts/demo.workflow.json
`.trim();

const DEFAULT_ARTIFACT = 'recording.json';

interface RecordOptions {
  segment?: 'new' | 'append';
  screenshots?: 'off' | 'markers' | 'events';
  privacy?: 'standard' | 'metadata';
  observe?: boolean;
  navigation?: 'all' | 'current-document';
  drainTimeout?: number;
  maxMb?: number;
  background?: boolean;
  workerId?: string;
  label?: string;
  subcommand?: RecordSubcommand;
  artifactPath?: string;
  output?: string;
  file?: string;
  timeout?: number;
  help?: boolean;
  useLatestSession?: boolean;
  listen?: boolean | ListenMode;
  bodies?: boolean;
  match?: string;
  maxPayload?: number;
  profile?: RecordProfile;
}

interface ResolvedConnection {
  browser: Browser;
  session: SessionData;
  isNewSession: boolean;
}

export function parseRecordArgs(args: string[]): RecordOptions {
  const options: RecordOptions = {};
  let nextIsArtifact = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (
      arg === '--segment' ||
      arg === '--screenshots' ||
      arg === '--privacy' ||
      arg === '--navigation'
    ) {
      const value = args[++i];
      const allowed =
        arg === '--segment'
          ? ['new', 'append']
          : arg === '--screenshots'
            ? ['off', 'markers', 'events']
            : arg === '--privacy'
              ? ['standard', 'metadata']
              : ['all', 'current-document'];
      if (!value || !allowed.includes(value))
        throw new Error(`${arg} requires ${allowed.join(' | ')}`);
      if (arg === '--segment') options.segment = value as RecordOptions['segment'];
      else if (arg === '--screenshots') options.screenshots = value as RecordOptions['screenshots'];
      else if (arg === '--privacy') options.privacy = value as RecordOptions['privacy'];
      else options.navigation = value as RecordOptions['navigation'];
    } else if (arg === '--observe') options.observe = true;
    else if (arg === '--background') options.background = true;
    else if (arg === '--worker-id') options.workerId = args[++i];
    else if (arg === '--label') options.label = args[++i];
    else if (arg === '--drain-timeout' || arg === '--max-mb') {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value <= 0)
        throw new Error(`${arg} requires a positive number`);
      if (arg === '--drain-timeout') options.drainTimeout = value;
      else options.maxMb = value;
    } else if (arg === '-f' || arg === '--file') {
      options.file = args[++i];
    } else if (arg === '--timeout') {
      options.timeout = Number(args[++i]);
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-s' || arg === '--session') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('-')) {
        options.useLatestSession = true;
      } else i++;
    } else if (arg === '--listen') {
      const nextArg = args[i + 1];
      if (nextArg === 'ws' || nextArg === 'http' || nextArg === 'all') {
        options.listen = nextArg;
        i++;
      } else {
        options.listen = true;
      }
    } else if (arg === '--bodies') {
      options.bodies = true;
    } else if (arg === '-m' || arg === '--match') {
      options.match = args[++i];
    } else if (arg === '--max-payload') {
      options.maxPayload = Number(args[++i]);
    } else if (arg === '--profile') {
      const profile = args[++i];
      if (
        profile === 'automation' ||
        profile === 'realtime' ||
        profile === 'voice' ||
        profile === 'auth'
      ) {
        options.profile = profile;
      } else throw new Error('--profile requires automation | realtime | voice | auth');
    } else if (arg === '-o' || arg === '--output') {
      options.output = args[++i];
    } else if (!arg.startsWith('-') && !options.subcommand && !nextIsArtifact) {
      if (isSubcommand(arg)) {
        options.subcommand = arg;
        nextIsArtifact = arg !== 'capture';
      } else if (!options.artifactPath) {
        options.artifactPath = arg;
      }
    } else if (!arg.startsWith('-') && nextIsArtifact && !options.artifactPath) {
      options.artifactPath = arg;
      nextIsArtifact = false;
    } else throw new Error(`Unexpected record argument: ${arg}`);
  }

  for (const flag of [
    '--worker-id',
    '--label',
    '-f',
    '--file',
    '-m',
    '--match',
    '-o',
    '--output',
  ]) {
    const index = args.indexOf(flag);
    if (index >= 0 && (!args[index + 1] || args[index + 1]!.startsWith('-')))
      throw new Error(`${flag} requires a value`);
  }

  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0))
    throw new Error('--timeout requires positive milliseconds');
  if (
    options.maxPayload !== undefined &&
    (!Number.isFinite(options.maxPayload) || options.maxPayload < 0)
  )
    throw new Error('--max-payload requires a nonnegative number');
  return options;
}

function isSubcommand(value: string): value is RecordSubcommand {
  return (
    value === 'capture' ||
    value === 'inspect' ||
    value === 'summary' ||
    value === 'derive' ||
    value === 'export' ||
    value === 'bundle' ||
    value === 'status' ||
    value === 'stop' ||
    value === 'marker'
  );
}

async function resolveConnection(
  sessionId: string | undefined,
  useLatestSession: boolean,
  debug: boolean,
  observe = false
): Promise<ResolvedConnection> {
  if (sessionId) {
    const session = await loadSession(sessionId);
    const { browser } = await attachSession(session, {
      trace: debug,
      ...(observe ? { policy: 'observe' as const } : {}),
    });
    return { browser, session, isNewSession: false };
  }

  if (useLatestSession) {
    const session = await getDefaultSession();
    if (!session) {
      throw new Error('No sessions found. Run "bp connect" first or omit -s to auto-connect.');
    }
    const { browser } = await attachSession(session, {
      trace: debug,
      ...(observe ? { policy: 'observe' as const } : {}),
    });
    return { browser, session, isNewSession: false };
  }

  let endpoint: Awaited<ReturnType<typeof resolveCLIEndpoint>>;
  try {
    endpoint = await resolveCLIEndpoint();
  } catch (error) {
    throw new Error(
      formatBrowserDiscoveryError(error, {
        explicitHint: '  - Create a session first: bp connect --browser-url <ws-url>',
        reuseSessionHint: 'bp record -s <session-id>',
        latestSessionHint: 'bp record -s',
      })
    );
  }

  const { browser, session } = await createLocalSession({
    wsUrl: endpoint.wsUrl,
    trace: debug,
    connectionSource: endpoint.source,
    resolvedChannel: endpoint.channel,
    resolvedUserDataDir: endpoint.userDataDir,
  });
  return { browser, session, isNewSession: true };
}

function artifactSessionDir(sessionId: string): string {
  return join(homedir(), '.browser-pilot', 'sessions', sessionId);
}

function resolveArtifactPath(explicit?: string, session?: SessionData): string {
  if (explicit) {
    return resolve(explicit);
  }
  if (session) {
    return join(artifactSessionDir(session.id), DEFAULT_ARTIFACT);
  }
  return resolve(DEFAULT_ARTIFACT);
}

function normalizeProfile(profile?: RecordProfile): RecordProfile {
  return profile ?? 'automation';
}

function tipsForArtifact(path: string) {
  const workflowPath = path.endsWith('.recording.json')
    ? `${path.slice(0, -'.recording.json'.length)}.workflow.json`
    : path.replace(/\.json$/, '.workflow.json');

  return {
    tip: {
      reason: 'summary_first',
      command: `bp record summary ${path}`,
    },
    alternateTips: [
      {
        reason: 'derive_replayable_steps',
        command: `bp record derive ${path} -o ${workflowPath}`,
      },
      {
        reason: 'inspect_trace_views',
        command: `bp trace summary ${path} --view ws`,
      },
    ],
  };
}

function buildSummary(artifact: RecordingManifest, source: string) {
  return {
    source,
    version: artifact.version,
    session: artifact.session,
    counts: {
      steps: artifact.recipe.steps.length,
      actions: artifact.actions.length,
      screenshots: artifact.screenshots.length,
      traceEvents: artifact.trace.events.length,
      assertions: artifact.assertions.length,
    },
    trace: artifact.trace.summaries,
    recording: artifact.recording,
    readiness: recordingReadiness(artifact),
    tips: tipsForArtifact(source),
  };
}

function deriveAssertions(artifact: RecordingManifest): Step[] {
  const assertions: Step[] = [];

  if (artifact.session.endUrl) {
    assertions.push({ action: 'assertUrl', expect: artifact.session.endUrl });
  }

  for (const action of artifact.actions) {
    if (
      action.action === 'fill' &&
      action.selector &&
      typeof action.value === 'string' &&
      action.value !== '[REDACTED]'
    ) {
      assertions.push({
        action: 'assertValue',
        selector: action.selector,
        expect: action.value,
      });
    }
  }

  return assertions;
}

async function loadArtifact(
  pathOrFallback: string
): Promise<{ path: string; artifact: RecordingManifest }> {
  if (!existsSync(pathOrFallback)) {
    throw new Error(`Artifact not found: ${pathOrFallback}`);
  }

  const raw = JSON.parse(nodeFs.readFileSync(pathOrFallback, 'utf-8')) as unknown;
  return {
    path: pathOrFallback,
    artifact: canonicalizeRecordingArtifact(
      raw && typeof raw === 'object' && 'artifact' in raw
        ? (raw as { artifact: unknown }).artifact
        : raw
    ),
  };
}

function artifactToFrames(artifact: RecordingManifest): RecordingFrame[] {
  const screenshotsByAction = new Map(artifact.screenshots.map((shot) => [shot.actionId, shot]));
  return artifact.actions.map((action, index) => {
    const screenshot = screenshotsByAction.get(action.id);
    return {
      seq: index + 1,
      timestamp: Date.parse(action.ts),
      action: action.action,
      selector: action.selector,
      selectorUsed: action.selectorUsed,
      value: action.value,
      url: action.url,
      coordinates: action.coordinates,
      boundingBox: action.boundingBox,
      success: action.success,
      durationMs: action.durationMs,
      error: action.error,
      screenshot: screenshot?.file ?? '',
      pageUrl: action.pageUrl,
      pageTitle: action.pageTitle,
      stepIndex: action.stepIndex,
      actionId: action.id,
    };
  });
}

async function runRecordCapture(
  args: RecordOptions,
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean }
): Promise<void> {
  if (
    args.privacy === 'metadata' &&
    (args.bodies || (args.screenshots && args.screenshots !== 'off'))
  )
    throw new Error('Metadata privacy requires response bodies off and --screenshots off');
  const profile = normalizeProfile(args.profile);
  const { browser, session } = await resolveConnection(
    globalOptions.session,
    args.useLatestSession ?? false,
    globalOptions.trace ?? false,
    args.observe
  );
  let page: Awaited<ReturnType<Browser['page']>> | undefined, recorder: Recorder | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let signalHandler: (() => void) | undefined;
  let state: RecordingControlState | undefined;
  let releaseReservation: (() => void) | undefined;
  let tick: Promise<void> | undefined;
  try {
    releaseReservation = reserveRecording(session.id);
    if (activeRecording(readRecordingState(session.id)))
      throw new Error('A recording is already active for this session; use record status/stop');
    // Preserve the named target, disable viewport remediation in observation mode.
    page = await browser.page('record-capture', {
      targetId: session.targetId,
      ...(args.observe ? { minViewport: false as const } : {}),
    });
    if (!(await browser.listTargets()).some((target) => target.targetId === page!.targetId))
      throw new Error('Exact recording target disappeared before readiness');
    const recordingId = args.workerId ?? randomUUID();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(recordingId))
      throw new Error('Invalid recording worker identity');
    const sessionDir = artifactSessionDir(session.id),
      relativeDir = `recordings/${recordingId}`;
    const segmentDir = join(sessionDir, relativeDir),
      screenshotDir = join(segmentDir, 'screenshots');
    const canonicalPath = join(sessionDir, DEFAULT_ARTIFACT),
      outputPath = resolve(args.file ?? DEFAULT_ARTIFACT);
    nodeFs.mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });
    const previous =
      existsSync(canonicalPath) && (args.segment ?? 'append') === 'append'
        ? canonicalizeRecordingArtifact(JSON.parse(nodeFs.readFileSync(canonicalPath, 'utf8')))
        : null;
    if (previous?.session.targetId && previous.session.targetId !== page.targetId)
      throw new Error('Append cannot mix targets; use --segment new');
    const frames: RecordingFrame[] = [],
      base = previous ? artifactToFrames(previous) : [];
    const screenshotPolicy = args.screenshots ?? (args.privacy === 'metadata' ? 'off' : 'events');
    let imageBytes = 0,
      stopReason: RecordingControlState['stopReason'] | undefined;
    const seenMarkers = new Set<string>();
    state = {
      schemaVersion: 1,
      recordingId,
      sessionId: session.id,
      targetId: page.targetId,
      pid: process.pid,
      status: 'starting',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      artifactPath: outputPath,
      canonicalPath,
      segmentPath: join(segmentDir, DEFAULT_ARTIFACT),
      screenshotDir,
      timeoutMs: args.timeout ?? 300000,
      maxBytes: (args.maxMb ?? 50) * 1024 * 1024,
      bytes: 0,
      events: 0,
      markers: [],
    };
    writeRecordingState(state);
    const listen: RecorderListenOptions = {
      mode: typeof args.listen === 'string' ? args.listen : 'all',
      match: args.match,
      captureResponseBodies: Boolean(args.bodies),
      maxPayload: args.maxPayload,
    };
    const cdp = page.cdpClient;
    async function capture(
      event: RawRecordedEvent,
      context: { sequence: number; signal: AbortSignal }
    ): Promise<void> {
      const frame: RecordingFrame = {
        seq: context.sequence,
        timestamp: event.timestamp,
        action: eventKindLabel(event.kind),
        selector: event.selectors[0]?.selector,
        value: event.value,
        coordinates: event.client,
        success: true,
        durationMs: 0,
        screenshot: '',
        pageUrl: event.url,
        stepIndex: context.sequence - 1,
        actionId: `event-${recordingId}-${context.sequence}`,
      };
      frames.push(frame); // Keep the action even if pixels fail or hit a bound.
      if (screenshotPolicy !== 'events') return;
      const filename = `${String(context.sequence).padStart(6, '0')}.webp`;
      const result = await cdp.send<{ data: string }>(
        'Page.captureScreenshot',
        {
          format: 'webp',
          quality: session.metadata?.record?.quality ?? 40,
          captureBeyondViewport: false,
        },
        undefined,
        { timeout: args.drainTimeout ?? 5000 }
      );
      if (context.signal.aborted) {
        frame.error = 'Screenshot cancelled by drain deadline';
        throw new Error(frame.error);
      }
      const bytes = Buffer.from(result.data, 'base64');
      if (
        bytes.length > 8 * 1024 * 1024 ||
        imageBytes + recorder!.byteCount + bytes.length > state!.maxBytes
      ) {
        frame.error = 'Screenshot skipped by byte limit';
        stopReason = 'size_limit';
        throw new Error(frame.error);
      }
      nodeFs.writeFileSync(join(screenshotDir, filename), bytes, { mode: 0o600 });
      imageBytes += bytes.length;
      frame.screenshot = `screenshots/${filename}`;
    }
    recorder = new Recorder(cdp, {
      listen,
      onEvent: capture,
      privacy: args.privacy,
      drainTimeoutMs: args.drainTimeout,
      navigation: args.navigation,
      maxBytes: state.maxBytes,
    });
    await recorder.start();
    state.status = 'ready';
    writeRecordingState(state);
    process.stderr.write(
      `Recording... Press Ctrl+C to stop. Artifact: ${outputPath}\nSession: ${session.id}\nRecording ID: ${recordingId}\n`
    );
    await new Promise<void>((resolveStop) => {
      let busy = false;
      signalHandler = () => {
        stopReason = 'signal';
        resolveStop();
      };
      process.on('SIGINT', signalHandler);
      process.on('SIGTERM', signalHandler);
      timer = setInterval(() => {
        if (busy) return;
        busy = true;
        tick = (async () => {
          if (recordingStopRequested(state!)) stopReason = 'requested';
          if (Date.now() - Date.parse(state!.startedAt) >= state!.timeoutMs) stopReason = 'timeout';
          for (const marker of readRecordingMarkers(state!))
            if (!seenMarkers.has(marker.id)) {
              seenMarkers.add(marker.id);
              state!.markers!.push({ id: marker.id, ...recorder!.marker(marker.label) });
              if (screenshotPolicy === 'markers') {
                const picture = await cdp.send<{ data: string }>(
                  'Page.captureScreenshot',
                  { format: 'webp', quality: 40, captureBeyondViewport: false },
                  undefined,
                  { timeout: 5000 }
                );
                const bytes = Buffer.from(picture.data, 'base64');
                if (
                  bytes.length > 8 * 1024 * 1024 ||
                  imageBytes + recorder!.byteCount + bytes.length > state!.maxBytes
                ) {
                  stopReason = 'size_limit';
                  break;
                }
                const filename = `marker-${marker.id}.webp`;
                nodeFs.writeFileSync(join(screenshotDir, filename), bytes, { mode: 0o600 });
                imageBytes += bytes.length;
                frames.push({
                  seq: frames.length + 1,
                  timestamp: Date.now(),
                  action: 'marker',
                  success: true,
                  durationMs: 0,
                  screenshot: `screenshots/${filename}`,
                  actionId: marker.id,
                });
              }
            }
          state!.events = recorder!.getEvents().length;
          // Include bounded runtime data in the cap; no raw response bodies in metadata mode.
          state!.bytes = imageBytes + recorder!.byteCount;
          if (recorder!.limitReached || state!.bytes >= state!.maxBytes) stopReason = 'size_limit';
          const targets = await browser.listTargets();
          if (!targets.some((target) => target.targetId === page!.targetId))
            stopReason = 'target_closed';
          writeRecordingState(state!);
          if (stopReason) resolveStop();
        })()
          .catch(() => {
            stopReason = 'target_closed';
            resolveStop();
          })
          .finally(() => {
            busy = false;
          });
      }, 100);
    });
    clearInterval(timer);
    timer = undefined;
    await tick;
    if (signalHandler) {
      process.off('SIGINT', signalHandler);
      process.off('SIGTERM', signalHandler);
      signalHandler = undefined;
    }
    state.status = 'stopping';
    state.stopReason = stopReason;
    writeRecordingState(state);
    const recording = await recorder.stop();
    const endUrl =
      args.privacy === 'metadata'
        ? redactRecordingURL(await page.url().catch(() => recording.startUrl))
        : await page.url().catch(() => recording.startUrl);
    const segment = createRecordingManifest({
      recordedAt: recording.recordedAt,
      sessionId: session.id,
      startUrl: recording.startUrl,
      endUrl,
      targetId: page.targetId,
      profile,
      steps: recording.steps,
      frames,
      traceEvents: recording.traceEvents ?? [],
      notes: [
        'Captures only subsequent interactions; browser starting state is not a restorable checkpoint.',
      ],
      screenshotDir: 'screenshots/',
    });
    segment.recording = {
      id: recordingId,
      segmentMode: args.segment ?? 'append',
      privacy: args.privacy ?? 'standard',
      screenshotPolicy,
      complete:
        !recording.capture?.drainTimedOut &&
        !recording.capture?.pending &&
        !recording.capture?.failed &&
        !recording.capture?.cleanupErrors.length &&
        stopReason !== 'size_limit' &&
        stopReason !== 'target_closed',
      capture: recording.capture,
      stopReason,
    };
    const prefixed = frames.map((frame) => ({
      ...frame,
      screenshot: frame.screenshot ? `${relativeDir}/${frame.screenshot}` : '',
    }));
    const manifest = createRecordingManifest({
      recordedAt: previous?.recordedAt ?? recording.recordedAt,
      sessionId: session.id,
      startUrl: previous?.session.startUrl ?? recording.startUrl,
      endUrl,
      targetId: page.targetId,
      profile,
      steps: [...(previous?.recipe.steps ?? []), ...recording.steps],
      frames: [...base, ...prefixed],
      traceEvents: [...(previous?.trace.events ?? []), ...(recording.traceEvents ?? [])],
      notes: [...(previous?.notes ?? []), ...segment.notes],
      executions: previous?.recipe.executions,
    });
    manifest.recording = segment.recording;
    manifest.assertions = deriveAssertions(manifest);
    nodeFs.writeFileSync(state.segmentPath, JSON.stringify(segment, null, 2), { mode: 0o600 });
    nodeFs.writeFileSync(canonicalPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    if (outputPath !== canonicalPath) {
      const exported = exportRecordingBundle(
        manifest,
        canonicalPath,
        `${outputPath}.assets/${recordingId}`
      );
      const portable = canonicalizeRecordingArtifact(
        JSON.parse(nodeFs.readFileSync(exported.manifest, 'utf8'))
      );
      for (const shot of portable.screenshots)
        shot.file = relative(
          dirname(outputPath),
          join(dirname(exported.manifest), shot.file)
        ).replaceAll('\\', '/');
      nodeFs.mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
      nodeFs.writeFileSync(outputPath, JSON.stringify(portable, null, 2), { mode: 0o600 });
    }
    state.status = 'complete';
    state.events = frames.length;
    writeRecordingState(state);
    if (globalOptions.format === 'json')
      output(
        {
          success: true,
          ...buildSummary(manifest, outputPath),
          locations: { canonicalPath, segmentPath: state.segmentPath, outputPath, screenshotDir },
        },
        'json'
      );
    else output({ success: true, ...buildSummary(manifest, outputPath) }, 'pretty');
  } catch (error) {
    if (state) {
      state.status = 'failed';
      state.error = error instanceof Error ? error.message : String(error);
      writeRecordingState(state);
    }
    throw error;
  } finally {
    if (timer) clearInterval(timer);
    if (signalHandler) {
      process.off('SIGINT', signalHandler);
      process.off('SIGTERM', signalHandler);
    }
    await recorder?.dispose();
    if (page) {
      const sid = page.cdpClient.sessionId;
      page.dispose();
      if (session.daemon && sid && sid !== session.daemon.cdpSessionId)
        await page.cdpClient.send('daemon.detach', { sessionId: sid }, null).catch(() => {});
    }
    await browser.disconnect();
    releaseReservation?.();
  }
}

async function runRecordInspect(
  pathHint: string | undefined,
  globalOptions: { session?: string; format?: 'json' | 'pretty' }
): Promise<void> {
  const session = globalOptions.session
    ? await loadSession(globalOptions.session)
    : await getDefaultSession();
  const artifactPath = resolveArtifactPath(pathHint, session ?? undefined);
  const { path, artifact } = await loadArtifact(artifactPath);
  output(buildSummary(artifact, path), globalOptions.format ?? 'pretty');
}

async function runRecordSummary(
  pathHint: string | undefined,
  globalOptions: { session?: string; format?: 'json' | 'pretty' }
): Promise<void> {
  const session = globalOptions.session
    ? await loadSession(globalOptions.session)
    : await getDefaultSession();
  const artifactPath = resolveArtifactPath(pathHint, session ?? undefined);
  const { path, artifact } = await loadArtifact(artifactPath);
  const summary = buildSummary(artifact, path);
  summary.trace = buildTraceSummaries(artifact.trace.events);
  output(summary, globalOptions.format ?? 'pretty');
}

async function runRecordDerive(
  pathHint: string | undefined,
  outputPath: string | undefined,
  globalOptions: { format?: 'json' | 'pretty'; session?: string }
): Promise<void> {
  if (!outputPath) {
    throw new Error('record derive requires -o <workflow.json>');
  }

  const session = globalOptions.session
    ? await loadSession(globalOptions.session)
    : await getDefaultSession();
  const artifactPath = resolveArtifactPath(pathHint, session ?? undefined);
  const { artifact } = await loadArtifact(artifactPath);
  const steps = artifact.recipe.steps;

  nodeFs.mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  nodeFs.writeFileSync(outputPath, JSON.stringify(steps, null, 2), { mode: 0o600 });
  const readiness = recordingReadiness(artifact);
  nodeFs.writeFileSync(`${outputPath}.readiness.json`, JSON.stringify(readiness, null, 2), {
    mode: 0o600,
  });

  output(
    {
      success: true,
      output: outputPath,
      steps: steps.length,
      suggestedAssertions: deriveAssertions(artifact),
      readiness: recordingReadiness(artifact),
      readinessPath: `${outputPath}.readiness.json`,
    },
    globalOptions.format ?? 'pretty'
  );
}

async function runRecordExport(
  pathHint: string | undefined,
  outputPath: string | undefined,
  globalOptions: { format?: 'json' | 'pretty'; session?: string }
): Promise<void> {
  if (!outputPath) {
    throw new Error('record export requires -o <bundle.json>');
  }

  const session = globalOptions.session
    ? await loadSession(globalOptions.session)
    : await getDefaultSession();
  const artifactPath = resolveArtifactPath(pathHint, session ?? undefined);
  const { artifact, path } = await loadArtifact(artifactPath);
  const bundle = {
    source: path,
    exportedAt: new Date().toISOString(),
    artifact,
    summary: buildSummary(artifact, path),
    images: Object.fromEntries(
      artifact.screenshots
        .filter((shot) => shot.file)
        .map((shot) => {
          const bytes = nodeFs.readFileSync(resolveRecordingImage(artifact, path, shot.file));
          return [
            shot.file,
            {
              base64: bytes.toString('base64'),
              sha256: createHash('sha256').update(bytes).digest('hex'),
            },
          ];
        })
    ),
  };

  nodeFs.mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  nodeFs.writeFileSync(outputPath, JSON.stringify(bundle, null, 2));

  output({ success: true, output: outputPath }, globalOptions.format ?? 'pretty');
}

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

export async function recordCommand(
  args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  const options = parseRecordArgs(args);
  const command = options.subcommand ?? 'capture';

  if (options.help || globalOptions.help) {
    console.log(RECORD_HELP);
    return;
  }

  if (command === 'status' || command === 'stop' || command === 'marker') {
    const session = await resolveSession(globalOptions.session);
    const current = readRecordingState(session.id);
    if (command === 'status') {
      output(
        { active: activeRecording(current), ...(current ?? { status: 'none' }) },
        globalOptions.format
      );
      return;
    }
    if (!current || !activeRecording(current))
      throw new Error('No active recording for this session');
    if (command === 'marker') {
      if (current.status !== 'ready') throw new Error('Recording is not ready');
      output(
        {
          recordingId: current.recordingId,
          markerId: requestRecordingMarker(
            current,
            options.label ?? options.artifactPath ?? 'marker'
          ),
          status: 'requested',
        },
        globalOptions.format
      );
      return;
    }
    requestRecordingStop(current);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const next = readRecordingState(session.id);
      if (next?.recordingId !== current.recordingId)
        throw new Error('Recording identity changed while stopping');
      if (next.status === 'complete' || next.status === 'failed') {
        output({ active: false, ...next }, globalOptions.format);
        return;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error('Recording stop is still pending; inspect record status');
  }
  if (command === 'capture' && options.background) {
    const session = await resolveSession(globalOptions.session);
    if (activeRecording(readRecordingState(session.id)))
      throw new Error('A recording is already active');
    const id = randomUUID(),
      log = recordingControlPaths(session.id).log;
    nodeFs.mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
    const fd = nodeFs.openSync(log, 'a', 0o600);
    const filtered = args.filter((arg) => arg !== '--background');
    const child = spawn(
      process.execPath,
      [
        resolve(process.argv[1]!),
        ...['record', ...filtered, '-s', session.id, '--worker-id', id, '--json'],
      ],
      { detached: true, stdio: ['ignore', fd, fd], env: process.env }
    );
    nodeFs.closeSync(fd);
    let spawnError: Error | undefined;
    child.on('error', (error) => {
      spawnError = error;
    });
    child.unref();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      const ready = readRecordingState(session.id);
      if (ready?.recordingId === id) {
        if (ready.status === 'failed') throw new Error(ready.error ?? 'Recording failed');
        if (ready.status === 'ready' || ready.status === 'complete') {
          output({ active: activeRecording(ready), ...ready }, globalOptions.format);
          return;
        }
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`Recording did not declare ready; inspect ${log}`);
  }
  if (command === 'capture') {
    await runRecordCapture(options, globalOptions);
    return;
  }

  const pathHint = options.artifactPath ?? DEFAULT_ARTIFACT;

  switch (command) {
    case 'inspect':
      await runRecordInspect(pathHint, globalOptions);
      break;
    case 'summary':
      await runRecordSummary(pathHint, globalOptions);
      break;
    case 'derive':
      await runRecordDerive(pathHint, options.output, globalOptions);
      break;
    case 'bundle': {
      if (!options.output) throw new Error('record bundle requires -o <fresh-directory>');
      const session = globalOptions.session
        ? await loadSession(globalOptions.session)
        : await getDefaultSession();
      const loaded = await loadArtifact(
        resolveArtifactPath(options.artifactPath, session ?? undefined)
      );
      output(
        { success: true, ...exportRecordingBundle(loaded.artifact, loaded.path, options.output) },
        globalOptions.format
      );
      break;
    }
    case 'export':
      await runRecordExport(pathHint, options.output, globalOptions);
      break;
    default:
      throw new Error(`Unknown record subcommand: ${command}`);
  }
}
