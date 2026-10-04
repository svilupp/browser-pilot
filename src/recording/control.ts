// Node-only, using the established trace sidecar control pattern; no browser actions.
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { isProcessAlive } from '../trace/background.ts';
import { getSessionTracePath } from '../trace/store.ts';

export interface RecordingControlState {
  schemaVersion: 1;
  recordingId: string;
  sessionId: string;
  targetId?: string;
  pid: number;
  status: 'starting' | 'ready' | 'stopping' | 'complete' | 'failed';
  startedAt: string;
  updatedAt: string;
  artifactPath: string;
  canonicalPath: string;
  segmentPath: string;
  screenshotDir: string;
  timeoutMs: number;
  maxBytes: number;
  bytes: number;
  events: number;
  stopReason?: 'requested' | 'signal' | 'timeout' | 'size_limit' | 'target_closed';
  error?: string;
  markers?: Array<{ id: string; label: string; sequence: number; elapsedMs: number; at: string }>;
}
export function recordingControlPaths(sessionId: string) {
  const dir = dirname(getSessionTracePath(sessionId));
  return {
    state: join(dir, 'record-capture.json'),
    stop: join(dir, 'record-capture.stop'),
    markers: join(dir, 'record-capture.markers.jsonl'),
    log: join(dir, 'record-capture.log'),
    lock: join(dir, 'record-capture.lock'),
  };
}
export function readRecordingState(sessionId: string): RecordingControlState | null {
  try {
    const value = JSON.parse(
      fs.readFileSync(recordingControlPaths(sessionId).state, 'utf8')
    ) as RecordingControlState;
    if (
      value.schemaVersion !== 1 ||
      value.sessionId !== sessionId ||
      !value.recordingId ||
      !Number.isSafeInteger(value.pid)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function activeRecording(state: RecordingControlState | null): boolean {
  return (
    !!state && ['starting', 'ready', 'stopping'].includes(state.status) && isProcessAlive(state.pid)
  );
}
export function writeRecordingState(state: RecordingControlState): void {
  const file = recordingControlPaths(state.sessionId).state;
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }), {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}
export function requestRecordingStop(state: RecordingControlState): void {
  fs.writeFileSync(recordingControlPaths(state.sessionId).stop, state.recordingId, { mode: 0o600 });
}
export function recordingStopRequested(state: RecordingControlState): boolean {
  try {
    return (
      fs.readFileSync(recordingControlPaths(state.sessionId).stop, 'utf8') === state.recordingId
    );
  } catch {
    return false;
  }
}
export function requestRecordingMarker(state: RecordingControlState, label: string): string {
  const id = randomUUID();
  fs.appendFileSync(
    recordingControlPaths(state.sessionId).markers,
    `${JSON.stringify({ recordingId: state.recordingId, id, label: label.slice(0, 256) })}\n`,
    { mode: 0o600 }
  );
  return id;
}
export function readRecordingMarkers(
  state: RecordingControlState
): Array<{ id: string; label: string }> {
  try {
    return fs
      .readFileSync(recordingControlPaths(state.sessionId).markers, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const v = JSON.parse(line) as Record<string, unknown>;
          return v['recordingId'] === state.recordingId &&
            typeof v['id'] === 'string' &&
            typeof v['label'] === 'string'
            ? [{ id: v['id'], label: v['label'].slice(0, 256) }]
            : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** Atomically reserve a session; a live owner cannot be overwritten by a racing recorder. */
export function reserveRecording(sessionId: string): () => void {
  const file = recordingControlPaths(sessionId).lock;
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => {
        if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || isProcessAlive(pid))
        throw new Error('A recording already owns this session');
      fs.unlinkSync(file);
    }
  }
  throw new Error('Unable to reserve recording session');
}
