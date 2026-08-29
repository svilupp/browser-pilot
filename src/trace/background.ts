import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { getSessionTracePath } from './store.ts';

export const DEFAULT_BACKGROUND_TRACE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_BACKGROUND_TRACE_MAX_BYTES = 100 * 1024 * 1024;

export type BackgroundTraceStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface BackgroundTraceState {
  schemaVersion: 1;
  captureId: string;
  sessionId: string;
  pid: number;
  status: BackgroundTraceStatus;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
  timeoutMs: number;
  maxBytes: number;
  tracePath: string;
  outputPath?: string;
  logPath: string;
  stopPath: string;
  stoppedAt?: string;
  stopReason?: 'signal' | 'timeout' | 'requested' | 'size_limit';
  events?: number;
  bytesWritten?: number;
  error?: string;
}

export function getBackgroundTracePaths(sessionId: string): {
  statePath: string;
  stopPath: string;
  logPath: string;
} {
  const sessionDir = dirname(getSessionTracePath(sessionId));
  return {
    statePath: join(sessionDir, 'trace-capture.json'),
    stopPath: join(sessionDir, 'trace-capture.stop'),
    logPath: join(sessionDir, 'trace-capture.log'),
  };
}

export function createCaptureId(): string {
  return randomUUID();
}

export function readBackgroundTraceState(sessionId: string): BackgroundTraceState | null {
  const { statePath } = getBackgroundTracePaths(sessionId);
  try {
    const value: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<BackgroundTraceState>;
    if (
      candidate.schemaVersion !== 1 ||
      typeof candidate.captureId !== 'string' ||
      typeof candidate.sessionId !== 'string' ||
      typeof candidate.pid !== 'number' ||
      typeof candidate.status !== 'string'
    ) {
      return null;
    }
    return candidate as BackgroundTraceState;
  } catch {
    return null;
  }
}

export function writeBackgroundTraceState(state: BackgroundTraceState): void {
  const { statePath } = getBackgroundTracePaths(state.sessionId);
  fs.mkdirSync(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, statePath);
}

export function updateBackgroundTraceState(
  sessionId: string,
  captureId: string,
  updates: Partial<Omit<BackgroundTraceState, 'schemaVersion' | 'captureId' | 'sessionId'>>
): BackgroundTraceState | null {
  const current = readBackgroundTraceState(sessionId);
  if (!current || current.captureId !== captureId) return null;
  const updated: BackgroundTraceState = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  writeBackgroundTraceState(updated);
  return updated;
}

export function requestBackgroundTraceStop(state: BackgroundTraceState): void {
  fs.mkdirSync(dirname(state.stopPath), { recursive: true });
  fs.writeFileSync(state.stopPath, `${state.captureId}\n`, 'utf8');
}

export function clearBackgroundTraceStop(sessionId: string): void {
  const { stopPath } = getBackgroundTracePaths(sessionId);
  try {
    fs.unlinkSync(stopPath);
  } catch {
    // Missing stop markers are the normal case.
  }
}

export function backgroundTraceStopRequested(stopPath: string, captureId: string): boolean {
  try {
    return fs.readFileSync(stopPath, 'utf8').trim() === captureId;
  } catch {
    return false;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isBackgroundTraceActive(state: BackgroundTraceState | null): boolean {
  return (
    !!state &&
    (state.status === 'starting' || state.status === 'running' || state.status === 'stopping') &&
    isProcessAlive(state.pid)
  );
}
