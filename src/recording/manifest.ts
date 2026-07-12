import type { Step } from '../actions/types.ts';
import { createExecutionId } from '../runtime/id.ts';
import type { CanonicalTraceEvent } from '../trace/model.ts';
import { buildTraceSummaries } from '../trace/views.ts';

export interface RecordingFrame {
  seq: number;
  timestamp: number;
  action: string;
  selector?: string;
  selectorUsed?: string;
  value?: string;
  url?: string;
  coordinates?: { x: number; y: number };
  boundingBox?: { x: number; y: number; width: number; height: number };
  success: boolean;
  durationMs: number;
  error?: string;
  screenshot: string;
  pageUrl?: string;
  pageTitle?: string;
  stepIndex?: number;
  actionId?: string;
  executionId?: string;
  attempt?: number;
  dispatchState?: string;
  retrySafe?: boolean;
  targetId?: string;
  effect?: string;
  anchor?: string;
}

export interface LegacyRecordingManifest {
  version: 1;
  recordedAt: string;
  sessionId: string;
  startUrl: string;
  endUrl: string;
  viewport: { width: number; height: number };
  format: 'png' | 'jpeg' | 'webp';
  quality: number;
  totalDurationMs: number;
  success: boolean;
  frames: RecordingFrame[];
  network?: {
    requests?: unknown[];
    responses?: unknown[];
  };
  websockets?: {
    events?: unknown[];
    frames?: unknown[];
  };
  timeline?: unknown[];
}

export interface RecordingAction {
  id: string;
  stepIndex: number;
  action: string;
  selector?: string;
  selectorUsed?: string;
  value?: string;
  url?: string;
  success: boolean;
  durationMs: number;
  error?: string;
  ts: string;
  pageUrl?: string;
  pageTitle?: string;
  coordinates?: { x: number; y: number };
  boundingBox?: { x: number; y: number; width: number; height: number };
  executionId?: string;
  attempt?: number;
  dispatchState?: string;
  retrySafe?: boolean;
  targetId?: string;
  effect?: string;
  anchor?: string;
}

export interface RecordingScreenshot {
  id: string;
  stepIndex: number;
  actionId: string;
  file: string;
  ts: string;
  success: boolean;
  pageUrl?: string;
  pageTitle?: string;
  coordinates?: { x: number; y: number };
  boundingBox?: { x: number; y: number; width: number; height: number };
  executionId?: string;
  attempt?: number;
  targetId?: string;
  effect?: string;
  anchor?: string;
}

export interface RecordingExecution {
  executionId: string;
  startedAt: string;
  steps: Step[];
  success: boolean;
}

export interface RecordingManifest {
  version: 2;
  recordedAt: string;
  session: {
    id: string;
    startUrl: string;
    endUrl: string;
    targetId?: string;
    profile?: string;
  };
  recipe: {
    steps: Step[];
    executions?: RecordingExecution[];
  };
  actions: RecordingAction[];
  screenshots: RecordingScreenshot[];
  trace: {
    events: CanonicalTraceEvent[];
    summaries: Record<string, unknown>;
  };
  assertions: Step[];
  notes: string[];
  artifacts: {
    recordingManifest: string;
    screenshotDir: string;
  };
}

interface ActionIdReference {
  oldId?: string;
  newId: string;
  stepIndex?: number;
  executionId?: string;
  attempt?: number;
}

export function isCanonicalRecordingManifest(value: unknown): value is RecordingManifest {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { version?: number }).version === 2 &&
      typeof (value as { session?: unknown }).session === 'object'
  );
}

export function isLegacyRecordingManifest(value: unknown): value is LegacyRecordingManifest {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { version?: number }).version === 1 &&
      Array.isArray((value as { frames?: unknown[] }).frames)
  );
}

export function createRecordingManifest(input: {
  recordedAt: string;
  sessionId: string;
  startUrl: string;
  endUrl: string;
  targetId?: string;
  profile?: string;
  steps: Step[];
  frames: RecordingFrame[];
  traceEvents: CanonicalTraceEvent[];
  assertions?: Step[];
  notes?: string[];
  recordingManifest?: string;
  screenshotDir?: string;
  executionId?: string;
  executions?: RecordingExecution[];
}): RecordingManifest {
  const executionId = input.executionId ?? createExecutionId('recording');
  const normalizedFrames = normalizeFrameIds(input.frames, executionId);
  const actionIdReferences = input.frames.map<ActionIdReference>((frame, index) => ({
    oldId: frame.actionId,
    newId: normalizedFrames[index]!.actionId!,
    stepIndex: normalizedFrames[index]!.stepIndex ?? Math.max(0, normalizedFrames[index]!.seq - 1),
    executionId: normalizedFrames[index]!.executionId,
    attempt: normalizedFrames[index]!.attempt,
  }));
  const traceEvents = normalizeTraceActionIds(input.traceEvents, actionIdReferences);
  const actions = normalizedFrames.map<RecordingAction>((frame) => {
    const actionId = frame.actionId!;
    return {
      id: actionId,
      stepIndex: frame.stepIndex ?? Math.max(0, frame.seq - 1),
      action: frame.action,
      selector: frame.selector,
      selectorUsed: frame.selectorUsed ?? frame.selector,
      value: frame.value,
      url: frame.url,
      success: frame.success,
      durationMs: frame.durationMs,
      error: frame.error,
      ts: new Date(frame.timestamp).toISOString(),
      pageUrl: frame.pageUrl,
      pageTitle: frame.pageTitle,
      coordinates: frame.coordinates,
      boundingBox: frame.boundingBox,
      executionId: frame.executionId ?? executionId,
      attempt: frame.attempt,
      dispatchState: frame.dispatchState,
      retrySafe: frame.retrySafe,
      targetId: frame.targetId,
      effect: frame.effect,
      anchor: frame.anchor,
    };
  });

  const screenshots = normalizedFrames.map<RecordingScreenshot>((frame, index) => ({
    id: `shot-${index + 1}`,
    stepIndex: frame.stepIndex ?? Math.max(0, frame.seq - 1),
    actionId: frame.actionId!,
    file: frame.screenshot,
    ts: new Date(frame.timestamp).toISOString(),
    success: frame.success,
    pageUrl: frame.pageUrl,
    pageTitle: frame.pageTitle,
    coordinates: frame.coordinates,
    boundingBox: frame.boundingBox,
    executionId: frame.executionId ?? executionId,
    attempt: frame.attempt,
    targetId: frame.targetId,
    effect: frame.effect,
    anchor: frame.anchor,
  }));

  const executions = [
    ...(input.executions ?? []),
    {
      executionId,
      startedAt: input.recordedAt,
      steps: input.steps,
      success: !(input.notes ?? []).some((note) => note.includes('failed')),
    },
  ];

  return {
    version: 2,
    recordedAt: input.recordedAt,
    session: {
      id: input.sessionId,
      startUrl: input.startUrl,
      endUrl: input.endUrl,
      targetId: input.targetId,
      profile: input.profile,
    },
    recipe: {
      steps: input.steps,
      executions,
    },
    actions,
    screenshots,
    trace: {
      events: traceEvents,
      summaries: buildTraceSummaries(traceEvents),
    },
    assertions: input.assertions ?? [],
    notes: input.notes ?? [],
    artifacts: {
      recordingManifest: input.recordingManifest ?? 'recording.json',
      screenshotDir: input.screenshotDir ?? 'screenshots/',
    },
  };
}

function normalizeFrameIds(frames: RecordingFrame[], executionId: string): RecordingFrame[] {
  const used = new Set<string>();
  return frames.map((frame, index) => {
    let actionId = frame.actionId;
    if (!actionId || used.has(actionId)) {
      actionId = `${executionId}-legacy-action-${index + 1}`;
    }
    used.add(actionId);
    return {
      ...frame,
      actionId,
      executionId: frame.executionId ?? executionId,
    };
  });
}

function referenceMatchesEvent(reference: ActionIdReference, event: CanonicalTraceEvent): boolean {
  if (event.stepIndex !== undefined && reference.stepIndex !== event.stepIndex) return false;
  if (event.executionId !== undefined && reference.executionId !== event.executionId) return false;
  if (event.attempt !== undefined && reference.attempt !== event.attempt) return false;
  return true;
}

function normalizeTraceActionIds(
  events: CanonicalTraceEvent[],
  references: ActionIdReference[]
): CanonicalTraceEvent[] {
  const occurrences = new Map<string, number>();
  const usedTraceIds = new Set<string>();

  return events.map((event, index) => {
    let actionId = event.actionId;
    if (actionId) {
      const candidates = references.filter(
        (reference) => reference.oldId === actionId || reference.newId === actionId
      );
      const matched =
        candidates.find((reference) => referenceMatchesEvent(reference, event)) ??
        candidates[occurrences.get(actionId) ?? 0] ??
        candidates[0];
      occurrences.set(actionId, (occurrences.get(actionId) ?? 0) + 1);
      actionId = matched?.newId ?? actionId;
    }

    let traceId = event.traceId;
    if (!traceId || usedTraceIds.has(traceId)) traceId = `legacy-trace-${index + 1}`;
    usedTraceIds.add(traceId);

    return {
      ...event,
      traceId,
      ...(actionId ? { actionId } : {}),
    };
  });
}

export interface RecordingIntegrityResult {
  valid: boolean;
  errors: string[];
}

export interface RecordingIntegrityOptions {
  /** Optional synchronous file-size probe supplied by a host runtime. */
  fileSize?: (path: string) => number | undefined;
}

function normalizeArtifactPath(artifactDir: string, screenshotDir: string, file: string): string {
  const root = artifactDir.replace(/\\/g, '/').replace(/\/$/, '');
  const dir = screenshotDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const relative = file.replace(/\\/g, '/').replace(/^\/+/, '');
  const alreadyScoped = dir.length === 0 || relative === dir || relative.startsWith(`${dir}/`);
  return `${root}/${alreadyScoped ? relative : `${dir}/${relative}`}`;
}

function nodeFileSize(path: string): number | undefined {
  // Avoid importing a Node-only module into the library entry point, which is
  // also used by browser/worker consumers. Node 22 exposes built-ins through
  // process.getBuiltinModule; older runtimes simply skip this optional probe.
  const processLike = (
    globalThis as {
      process?: { getBuiltinModule?: (name: string) => unknown };
    }
  ).process;
  const getBuiltinModule = processLike?.getBuiltinModule;
  if (typeof getBuiltinModule !== 'function') return undefined;
  try {
    const fs = getBuiltinModule('node:fs') as {
      statSync: (filePath: string) => { size: number };
    };
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}

/** Validate action/screenshot identity and, when supplied, evidence files. */
export function validateRecordingManifest(
  manifest: RecordingManifest,
  artifactDir?: string,
  options: RecordingIntegrityOptions = {}
): RecordingIntegrityResult {
  const errors: string[] = [];
  const actionIds = new Set<string>();
  for (const action of manifest.actions) {
    if (actionIds.has(action.id)) errors.push(`Duplicate action ID: ${action.id}`);
    actionIds.add(action.id);
  }
  const screenshotIds = new Set<string>();
  for (const screenshot of manifest.screenshots) {
    if (screenshotIds.has(screenshot.id)) errors.push(`Duplicate screenshot ID: ${screenshot.id}`);
    screenshotIds.add(screenshot.id);
    if (!actionIds.has(screenshot.actionId)) {
      errors.push(`Screenshot ${screenshot.id} references missing action ${screenshot.actionId}`);
    }
    if (artifactDir) {
      const path = normalizeArtifactPath(
        artifactDir,
        manifest.artifacts.screenshotDir,
        screenshot.file
      );
      const size = (options.fileSize ?? nodeFileSize)(path);
      if (size !== undefined && size <= 0) {
        errors.push(`Screenshot file is missing or empty: ${screenshot.file}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function assertRecordingManifestIntegrity(
  manifest: RecordingManifest,
  artifactDir?: string
): void {
  const result = validateRecordingManifest(manifest, artifactDir);
  if (!result.valid)
    throw new Error(`Recording manifest integrity failure: ${result.errors.join('; ')}`);
}

export function canonicalizeRecordingArtifact(value: unknown): RecordingManifest {
  if (isCanonicalRecordingManifest(value)) {
    const actions = normalizeCanonicalActionIds(value);
    return actions;
  }

  if (!isLegacyRecordingManifest(value)) {
    throw new Error('Unsupported recording artifact');
  }

  const traceEvents = buildTraceEventsFromLegacy(value);
  const steps = value.frames.map((frame) => frameToStep(frame));

  return createRecordingManifest({
    recordedAt: value.recordedAt,
    sessionId: value.sessionId,
    startUrl: value.startUrl,
    endUrl: value.endUrl,
    steps,
    frames: value.frames,
    traceEvents,
    notes: ['Converted from legacy recording manifest'],
  });
}

function normalizeCanonicalActionIds(value: RecordingManifest): RecordingManifest {
  const actionIds: string[] = [];
  const used = new Set<string>();
  const actions = value.actions.map((action, index) => {
    let id = action.id;
    if (!id || used.has(id)) id = `legacy-action-${index + 1}`;
    used.add(id);
    actionIds.push(id);
    return { ...action, id };
  });
  const references = value.actions.map<ActionIdReference>((action, index) => ({
    oldId: action.id,
    newId: actionIds[index]!,
    stepIndex: action.stepIndex,
    executionId: action.executionId,
    attempt: action.attempt,
  }));
  const occurrences = new Map<string, number>();
  const screenshots = value.screenshots.map((screenshot, index) => {
    const candidates = references.filter(
      (reference) =>
        reference.oldId === screenshot.actionId || reference.newId === screenshot.actionId
    );
    const occurrence = occurrences.get(screenshot.actionId) ?? 0;
    occurrences.set(screenshot.actionId, occurrence + 1);
    const actionId = candidates[occurrence]?.newId ?? actionIds[index] ?? screenshot.actionId;
    return { ...screenshot, actionId, id: `shot-${index + 1}` };
  });
  const traceEvents = normalizeTraceActionIds(value.trace.events, references);
  return {
    ...value,
    actions,
    screenshots,
    trace: {
      ...value.trace,
      events: traceEvents,
      summaries: buildTraceSummaries(traceEvents),
    },
  };
}

function buildTraceEventsFromLegacy(value: LegacyRecordingManifest): CanonicalTraceEvent[] {
  const events: CanonicalTraceEvent[] = [];

  for (const frame of value.frames) {
    events.push({
      traceId: frame.actionId ?? `legacy-${frame.seq}`,
      sessionId: value.sessionId,
      ts: new Date(frame.timestamp).toISOString(),
      elapsedMs: frame.timestamp - new Date(value.recordedAt).getTime(),
      channel: 'action',
      event: frame.success ? 'action.succeeded' : 'action.failed',
      severity: frame.success ? 'info' : 'error',
      summary: `${frame.action}${frame.selector ? ` ${frame.selector}` : ''}`,
      data: {
        action: frame.action,
        selector: frame.selector,
        value: frame.value ?? null,
        pageUrl: frame.pageUrl ?? null,
        pageTitle: frame.pageTitle ?? null,
        screenshot: frame.screenshot,
      },
      actionId: frame.actionId ?? `action-${frame.seq}`,
      executionId: frame.executionId,
      attempt: frame.attempt,
      stepIndex: frame.stepIndex ?? Math.max(0, frame.seq - 1),
      selector: frame.selector,
      selectorUsed: frame.selectorUsed ?? frame.selector,
      url: frame.pageUrl ?? frame.url,
    });
  }

  return events;
}

function frameToStep(frame: RecordingFrame): Step {
  switch (frame.action) {
    case 'fill':
      return { action: 'fill', selector: frame.selector, value: frame.value };
    case 'submit':
      return { action: 'submit', selector: frame.selector };
    case 'goto':
      return { action: 'goto', url: frame.url ?? frame.pageUrl };
    case 'press':
      return { action: 'press', key: frame.value ?? 'Enter' };
    default:
      return { action: 'click', selector: frame.selector };
  }
}
