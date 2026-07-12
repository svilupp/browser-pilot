import { describe, expect, test } from 'bun:test';
import {
  canonicalizeRecordingArtifact,
  type LegacyRecordingManifest,
  type RecordingManifest,
  validateRecordingManifest,
} from '../../src/recording/manifest.ts';

function event(actionId: string, stepIndex: number, traceId: string) {
  return {
    traceId,
    ts: '2026-07-11T00:00:00.000Z',
    elapsedMs: stepIndex,
    channel: 'action' as const,
    event: 'action.succeeded',
    severity: 'info' as const,
    summary: `step ${stepIndex}`,
    data: {},
    actionId,
    stepIndex,
  };
}

function legacyFrame(seq: number, actionId: string) {
  return {
    seq,
    timestamp: 1_000 + seq,
    action: 'click',
    selector: `#button-${seq}`,
    success: true,
    durationMs: 1,
    screenshot: `shot-${seq}.png`,
    stepIndex: seq - 1,
    actionId,
  };
}

describe('recording manifest migration', () => {
  test('validates screenshot paths without a Bun-specific runtime', () => {
    const manifest: RecordingManifest = {
      version: 2,
      recordedAt: '2026-07-11T00:00:00.000Z',
      session: { id: 'session-1', startUrl: '', endUrl: '' },
      recipe: { steps: [] },
      actions: [{ id: 'a', stepIndex: 0, action: 'click', success: true, durationMs: 1, ts: '' }],
      screenshots: [
        {
          id: 'shot-1',
          stepIndex: 0,
          actionId: 'a',
          file: 'screenshots/shot.png',
          ts: '',
          success: true,
        },
      ],
      trace: { events: [], summaries: {} },
      assertions: [],
      notes: [],
      artifacts: { recordingManifest: 'recording.json', screenshotDir: 'screenshots/' },
    };
    let checkedPath = '';
    const result = validateRecordingManifest(manifest, '/tmp/artifact', {
      fileSize: (path) => {
        checkedPath = path;
        return 1;
      },
    });
    expect(result.valid).toBe(true);
    expect(checkedPath).toBe('/tmp/artifact/screenshots/shot.png');
  });

  test('repairs duplicate legacy trace action IDs by step identity', () => {
    const artifact: LegacyRecordingManifest = {
      version: 1,
      recordedAt: '2026-07-11T00:00:00.000Z',
      sessionId: 'session-1',
      startUrl: 'https://example.test/start',
      endUrl: 'https://example.test/end',
      viewport: { width: 1280, height: 720 },
      format: 'png',
      quality: 100,
      totalDurationMs: 2,
      success: true,
      frames: [legacyFrame(1, 'action-1'), legacyFrame(2, 'action-1')],
    };

    const migrated = canonicalizeRecordingArtifact(artifact);
    const actionIds = migrated.actions.map((action) => action.id);
    const traceActionIds = migrated.trace.events.map((trace) => trace.actionId);

    expect(new Set(actionIds).size).toBe(2);
    expect(traceActionIds).toEqual(actionIds);
    expect(new Set(migrated.trace.events.map((trace) => trace.traceId)).size).toBe(2);
    expect(migrated.screenshots.map((screenshot) => screenshot.actionId)).toEqual(actionIds);
  });

  test('repairs duplicate action and trace IDs in canonical artifacts', () => {
    const artifact: RecordingManifest = {
      version: 2,
      recordedAt: '2026-07-11T00:00:00.000Z',
      session: {
        id: 'session-1',
        startUrl: 'https://example.test/start',
        endUrl: 'https://example.test/end',
      },
      recipe: { steps: [] },
      actions: [
        {
          id: 'legacy-action',
          stepIndex: 0,
          action: 'click',
          success: true,
          durationMs: 1,
          ts: '2026-07-11T00:00:00.000Z',
        },
        {
          id: 'legacy-action',
          stepIndex: 1,
          action: 'click',
          success: true,
          durationMs: 1,
          ts: '2026-07-11T00:00:00.000Z',
        },
      ],
      screenshots: [
        {
          id: 'shot-1',
          stepIndex: 0,
          actionId: 'legacy-action',
          file: 'shot-1.png',
          ts: '2026-07-11T00:00:00.000Z',
          success: true,
        },
        {
          id: 'shot-2',
          stepIndex: 1,
          actionId: 'legacy-action',
          file: 'shot-2.png',
          ts: '2026-07-11T00:00:00.000Z',
          success: true,
        },
      ],
      trace: {
        events: [event('legacy-action', 0, 'trace-1'), event('legacy-action', 1, 'trace-1')],
        summaries: {},
      },
      assertions: [],
      notes: [],
      artifacts: { recordingManifest: 'recording.json', screenshotDir: 'screenshots/' },
    };

    const migrated = canonicalizeRecordingArtifact(artifact);
    const actionIds = migrated.actions.map((action) => action.id);

    expect(new Set(actionIds).size).toBe(2);
    expect(migrated.trace.events.map((trace) => trace.actionId)).toEqual(actionIds);
    expect(migrated.screenshots.map((screenshot) => screenshot.actionId)).toEqual(actionIds);
    expect(new Set(migrated.trace.events.map((trace) => trace.traceId)).size).toBe(2);
  });
});
