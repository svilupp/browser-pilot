import type { Step } from '../actions/types.ts';
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
}): RecordingManifest {
  const actions = input.frames.map<RecordingAction>((frame) => {
    const actionId = frame.actionId ?? `action-${frame.seq}`;
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
    };
  });

  const screenshots = input.frames.map<RecordingScreenshot>((frame) => ({
    id: `shot-${frame.seq}`,
    stepIndex: frame.stepIndex ?? Math.max(0, frame.seq - 1),
    actionId: frame.actionId ?? `action-${frame.seq}`,
    file: frame.screenshot,
    ts: new Date(frame.timestamp).toISOString(),
    success: frame.success,
    pageUrl: frame.pageUrl,
    pageTitle: frame.pageTitle,
    coordinates: frame.coordinates,
    boundingBox: frame.boundingBox,
  }));

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
    },
    actions,
    screenshots,
    trace: {
      events: input.traceEvents,
      summaries: buildTraceSummaries(input.traceEvents),
    },
    assertions: input.assertions ?? [],
    notes: input.notes ?? [],
    artifacts: {
      recordingManifest: input.recordingManifest ?? 'recording.json',
      screenshotDir: input.screenshotDir ?? 'screenshots/',
    },
  };
}

export function canonicalizeRecordingArtifact(value: unknown): RecordingManifest {
  if (isCanonicalRecordingManifest(value)) {
    return value;
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
