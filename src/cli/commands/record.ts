import * as nodeFs from 'node:fs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Step } from '../../actions/types.ts';
import { connect } from '../../index.ts';
import {
  canonicalizeRecordingArtifact,
  createRecordingManifest,
  type RecordingFrame,
  type RecordingManifest,
} from '../../recording/manifest.ts';
import {
  type ListenMode,
  Recorder,
  type RecorderListenOptions,
  type RecorderOptions,
} from '../../recording/recorder.ts';
import { redactValueForRecording } from '../../recording/redaction.ts';
import type { RawRecordedEvent } from '../../recording/types.ts';
import { buildTraceSummaries } from '../../trace/views.ts';
import { formatBrowserDiscoveryError, resolveCLIEndpoint } from '../browser-endpoint.ts';
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

type RecordProfile = 'automation' | 'realtime' | 'voice' | 'auth';
type RecordSubcommand = 'capture' | 'inspect' | 'summary' | 'derive' | 'export';

const RECORD_HELP = `
bp record - Capture a human demo into one canonical artifact

When to use:
  A human is demonstrating the workflow and you want replayable automation later.

When not to use:
  You already have steps and just want to run or validate them. Use \`bp exec\` or \`bp run\`.

Default flow:
  capture -> summary -> inspect or trace -> derive -> run

Common mistake:
  Opening \`recording.json\` first. Start with \`bp record summary\`.

Usage:
  bp record [options]
  bp record <inspect|summary|derive|export> [artifact] [options]

Capture options:
  -s, --session [id]   Session to use (omit: auto-connect, -s: latest, -s <id>: specific)
  -f, --file <path>    Artifact output path (default: recording.json)
  --timeout <ms>       Auto-stop after timeout
  --profile <name>     automation | realtime | voice | auth (default: automation)
  --listen [mode]      ws | http | all (default: all)
  --bodies             Capture HTTP response bodies
  -m, --match <glob>   Filter HTTP/WS URLs
  --max-payload <n>    Max WebSocket payload preview length (default: 256)

Artifact subcommands:
  inspect [artifact]   Show artifact metadata and next commands
  summary [artifact]   Show workflow summary plus trace views
  derive <artifact> -o <output>   Write replayable steps for bp run
  export <artifact> -o <output>   Write canonical triage bundle

Examples:
  bp record -s demo --profile automation
  bp record --profile voice --bodies
  bp record summary recording.json
  bp record inspect recording.json
  bp record derive recording.json -o workflow.json
  bp record export recording.json -o bundle.json

Likely next commands:
  bp record summary recording.json
  bp trace summary recording.json --view ws
  bp record derive recording.json -o workflow.json
`.trim();

const DEFAULT_ARTIFACT = 'recording.json';

interface RecordOptions {
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
  browser: ReturnType<typeof connect> extends Promise<infer T> ? T : never;
  session: SessionData;
  isNewSession: boolean;
}

export function parseRecordArgs(args: string[]): RecordOptions {
  const options: RecordOptions = {};
  let nextIsArtifact = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '-f' || arg === '--file') {
      options.file = args[++i];
    } else if (arg === '--timeout') {
      options.timeout = Number.parseInt(args[++i] ?? '', 10);
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-s' || arg === '--session') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('-')) {
        options.useLatestSession = true;
      }
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
      options.maxPayload = Number.parseInt(args[++i] ?? '', 10);
    } else if (arg === '--profile') {
      const profile = args[++i];
      if (
        profile === 'automation' ||
        profile === 'realtime' ||
        profile === 'voice' ||
        profile === 'auth'
      ) {
        options.profile = profile;
      }
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
    }
  }

  return options;
}

function isSubcommand(value: string): value is RecordSubcommand {
  return (
    value === 'capture' ||
    value === 'inspect' ||
    value === 'summary' ||
    value === 'derive' ||
    value === 'export'
  );
}

async function resolveConnection(
  sessionId: string | undefined,
  useLatestSession: boolean,
  debug: boolean
): Promise<ResolvedConnection> {
  if (sessionId) {
    const session = await loadSession(sessionId);
    const browser = await connect({
      provider: session.provider,
      wsUrl: session.wsUrl,
      debug,
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
      debug,
    });
    return { browser, session, isNewSession: false };
  }

  let wsUrl: string;
  try {
    wsUrl = (await resolveCLIEndpoint()).wsUrl;
  } catch (error) {
    throw new Error(
      formatBrowserDiscoveryError(error, {
        explicitHint: '  - Create a session first: bp connect --browser-url <ws-url>',
        reuseSessionHint: 'bp record -s <session-id>',
        latestSessionHint: 'bp record -s',
      })
    );
  }

  const browser = await connect({
    provider: 'generic',
    wsUrl,
    debug,
  });
  const page = await browser.page();
  const currentUrl = await page.url();
  const session: SessionData = {
    id: generateSessionId(),
    provider: 'generic',
    wsUrl: browser.wsUrl,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    currentUrl,
  };
  await saveSession(session);
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
  return {
    tip: {
      reason: 'summary_first',
      command: `bp record summary ${path}`,
    },
    alternateTips: [
      {
        reason: 'derive_replayable_steps',
        command: `bp record derive ${path} -o workflow.json`,
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
    tips: tipsForArtifact(source),
  };
}

function deriveAssertions(artifact: RecordingManifest): Step[] {
  const assertions: Step[] = [];

  if (artifact.session.endUrl) {
    assertions.push({ action: 'assertUrl', expect: artifact.session.endUrl });
  }

  for (const action of artifact.actions) {
    if (action.action === 'fill' && action.selector && typeof action.value === 'string') {
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
  return { path: pathOrFallback, artifact: canonicalizeRecordingArtifact(raw) };
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
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  const profile = normalizeProfile(args.profile);
  const { browser, session, isNewSession } = await resolveConnection(
    globalOptions.session,
    args.useLatestSession ?? false,
    globalOptions.trace ?? false
  );

  if (isNewSession) {
    console.log(`Created new session: ${session.id}`);
  }

  if (!session.metadata?.record) {
    const recordSettings: RecordSettings = {};
    await updateSession(session.id, { metadata: { record: recordSettings } });
  }

  const page = await browser.page(undefined, { targetId: session.targetId });
  const cdp = page.cdpClient;
  const sessionDir = artifactSessionDir(session.id);
  const screenshotDir = join(sessionDir, 'screenshots');
  const canonicalPath = join(sessionDir, DEFAULT_ARTIFACT);
  const outputPath = resolve(args.file ?? DEFAULT_ARTIFACT);

  nodeFs.mkdirSync(screenshotDir, { recursive: true });

  const existingArtifact = existsSync(canonicalPath)
    ? canonicalizeRecordingArtifact(
        JSON.parse(nodeFs.readFileSync(canonicalPath, 'utf-8')) as unknown
      )
    : null;
  const recordingFrames = existingArtifact ? artifactToFrames(existingArtifact) : [];

  let listenConfig: RecorderListenOptions | boolean | undefined = {
    mode: typeof args.listen === 'string' ? args.listen : 'all',
    match: args.match,
    captureResponseBodies: Boolean(args.bodies),
    maxPayload: args.maxPayload,
  };
  if (args.listen === false) {
    listenConfig = undefined;
  }

  if (!args.listen && profile === 'voice') {
    listenConfig = {
      mode: 'all',
      match: args.match,
      captureResponseBodies: Boolean(args.bodies),
      maxPayload: args.maxPayload,
    };
  }

  const recordSettings = session.metadata?.record;
  const recordFormat = recordSettings?.format ?? 'webp';
  const recordQuality = recordSettings?.quality ?? 40;

  let screenshotCount = 0;

  async function captureScreenshotForEvent(event: RawRecordedEvent): Promise<void> {
    try {
      const ts = Date.now();
      const seq = String(recordingFrames.length + 1).padStart(4, '0');
      const label = eventKindLabel(event.kind);
      const filename = `${seq}-${ts}-${label}.${recordFormat}`;
      const filepath = join(screenshotDir, filename);
      const result = await cdp.send<{ data: string }>('Page.captureScreenshot', {
        format: recordFormat === 'png' ? 'png' : recordFormat === 'jpeg' ? 'jpeg' : 'webp',
        quality: recordFormat === 'png' ? undefined : recordQuality,
      });
      nodeFs.writeFileSync(filepath, Buffer.from(result.data, 'base64'));

      let pageUrl: string | undefined;
      let pageTitle: string | undefined;
      try {
        pageUrl = await page.url();
        pageTitle = await page.title();
      } catch {
        // best effort
      }

      const targetMetadata = event.element
        ? {
            tagName: event.element['tag'],
            inputType: event.element['type'] ?? undefined,
          }
        : undefined;

      recordingFrames.push({
        seq: recordingFrames.length + 1,
        timestamp: ts,
        action: label,
        selector: event.selectors?.[0]?.selector,
        selectorUsed: event.selectors?.[0]?.selector,
        value: redactValueForRecording(event.value, targetMetadata),
        coordinates: event.client,
        success: true,
        durationMs: 0,
        screenshot: `screenshots/${filename}`,
        pageUrl,
        pageTitle,
        stepIndex: recordingFrames.length,
        actionId: `action-${recordingFrames.length + 1}`,
      });
      screenshotCount += 1;
    } catch {
      // best effort
    }
  }

  const recorderOptions: RecorderOptions = {
    ...(listenConfig ? { listen: listenConfig } : {}),
    onEvent: captureScreenshotForEvent,
  };

  const recorder = new Recorder(cdp, recorderOptions);
  let stopping = false;

  const stopAndSave = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;

    try {
      const recording = await recorder.stop();
      const currentUrl = await page.url().catch(() => recording.startUrl);
      const manifest = createRecordingManifest({
        recordedAt: existingArtifact?.recordedAt ?? recording.recordedAt,
        sessionId: session.id,
        startUrl: existingArtifact?.session.startUrl ?? recording.startUrl,
        endUrl: currentUrl,
        targetId: page.targetId,
        profile,
        steps: recording.steps,
        frames: recordingFrames,
        traceEvents: recording.traceEvents ?? [],
        assertions: deriveAssertions(
          createRecordingManifest({
            recordedAt: recording.recordedAt,
            sessionId: session.id,
            startUrl: recording.startUrl,
            endUrl: currentUrl,
            targetId: page.targetId,
            profile,
            steps: recording.steps,
            frames: recordingFrames,
            traceEvents: recording.traceEvents ?? [],
          })
        ),
        notes: profile === 'voice' ? ['Voice profile capture'] : [],
        recordingManifest: DEFAULT_ARTIFACT,
        screenshotDir: 'screenshots/',
      });

      nodeFs.writeFileSync(canonicalPath, JSON.stringify(manifest, null, 2));
      if (outputPath !== canonicalPath) {
        nodeFs.mkdirSync(dirname(outputPath), { recursive: true });
        nodeFs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
      }

      await updateSession(session.id, { currentUrl });
      await browser.disconnect();

      const summary = buildSummary(manifest, outputPath);
      if (globalOptions.format === 'json') {
        output({ success: true, ...summary }, 'json');
      } else {
        console.log(
          `Saved ${manifest.recipe.steps.length} steps, ${screenshotCount} screenshots, ${manifest.trace.events.length} trace events to ${outputPath}`
        );
        console.log(`Use: bp record summary ${outputPath}`);
      }
    } catch (error) {
      console.error(
        `Error saving recording: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exit(1);
    }
  };

  const handleSignal = () => {
    void stopAndSave();
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  if (args.timeout && args.timeout > 0) {
    setTimeout(() => void stopAndSave(), args.timeout);
  }

  await recorder.start();
  console.log(`Recording... Press Ctrl+C to stop. Artifact: ${outputPath}`);
  console.log(`Session: ${session.id}`);
  console.log(`Profile: ${profile}`);
  console.log(`URL: ${await page.url()}`);
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
  nodeFs.writeFileSync(outputPath, JSON.stringify(steps, null, 2));

  output(
    {
      success: true,
      output: outputPath,
      steps: steps.length,
      suggestedAssertions: deriveAssertions(artifact),
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
    case 'export':
      await runRecordExport(pathHint, options.output, globalOptions);
      break;
    default:
      throw new Error(`Unknown record subcommand: ${command}`);
  }
}
