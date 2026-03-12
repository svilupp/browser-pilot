import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CanonicalTraceEvent } from './model.ts';

export const TRACE_FILE_NAME = 'trace.jsonl';
const SESSION_DIR = join(homedir(), '.browser-pilot', 'sessions');

export function getSessionTracePath(sessionId: string): string {
  return join(SESSION_DIR, sessionId, TRACE_FILE_NAME);
}

export function ensureTraceFile(path: string): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  if (!fs.existsSync(path)) {
    fs.writeFileSync(path, '', 'utf-8');
  }
}

export function appendTraceEvent(path: string, event: CanonicalTraceEvent): void {
  ensureTraceFile(path);
  fs.appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf-8');
}

export function appendTraceEvents(path: string, events: CanonicalTraceEvent[]): void {
  if (events.length === 0) {
    return;
  }

  ensureTraceFile(path);
  fs.appendFileSync(
    path,
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf-8'
  );
}

export function writeTraceEvents(path: string, events: CanonicalTraceEvent[]): void {
  ensureTraceFile(path);
  fs.writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf-8');
}

export function readTraceEvents(path: string): CanonicalTraceEvent[] {
  const resolved = resolve(path);
  if (!fs.existsSync(resolved)) {
    return [];
  }

  const content = fs.readFileSync(resolved, 'utf-8').trim();
  if (!content) {
    return [];
  }

  return content
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line) as CanonicalTraceEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is CanonicalTraceEvent => event !== null);
}
