/**
 * Session logger for canonical trace logging.
 * Writes JSON Lines format to ~/.browser-pilot/sessions/{sessionId}/trace.jsonl
 * and projects compatibility-friendly log entries for list/tail surfaces.
 */

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { FailureHint } from '../browser/types.ts';
import type { CanonicalTraceEvent } from '../trace/model.ts';
import { createTraceId, normalizeTraceEvent } from '../trace/model.ts';
import { TRACE_FILE_NAME } from '../trace/store.ts';

/**
 * A single log entry
 */
export interface LogEntry {
  seq: number;
  ts: string;
  type: 'command' | 'event' | 'error';
  cmd?: string;
  args?: Record<string, unknown>;
  status?: 'pending' | 'success' | 'failed';
  durationMs?: number;
  selectorUsed?: string;
  urlBefore?: string;
  urlAfter?: string;
  error?: string;
  hints?: FailureHint[];
  /** Screenshot filename captured for this action (when recording enabled) */
  screenshotFile?: string;
}

/**
 * Log statistics
 */
export interface LogStats {
  entries: number;
  size: number;
  first?: string;
  last?: string;
}

const SESSION_DIR = join(homedir(), '.browser-pilot', 'sessions');

/**
 * Session logger for structured event logging
 */
export class SessionLogger {
  private logPath: string;
  private exportLogPath: string | null = null;
  private seq: number = 0;
  private sessionId: string;

  constructor(sessionId: string, exportLogPath?: string) {
    this.sessionId = sessionId;
    const sessionDir = join(SESSION_DIR, sessionId);
    this.logPath = join(sessionDir, TRACE_FILE_NAME);

    // Ensure core directory exists
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    // Setup export log if specified
    if (exportLogPath) {
      this.exportLogPath = resolve(exportLogPath);
      const exportDir = dirname(this.exportLogPath);
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }
    }

    // Load existing seq number from log if it exists
    if (fs.existsSync(this.logPath)) {
      this.seq = this.countEntries();
    }
  }

  /**
   * Log a raw compatibility entry through the canonical trace substrate.
   */
  log(entry: Omit<LogEntry, 'seq' | 'ts'>): void {
    const fullEntry: LogEntry = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      ...entry,
    };

    this.logTrace(this.compatibilityEntryToTrace(fullEntry));
  }

  logTrace(
    event: Partial<CanonicalTraceEvent> & Pick<CanonicalTraceEvent, 'channel' | 'event' | 'summary'>
  ): void {
    const normalized = normalizeTraceEvent({
      traceId: event.traceId ?? createTraceId(event.channel),
      sessionId: this.sessionId,
      ...event,
    });
    const line = `${JSON.stringify(normalized)}\n`;

    fs.appendFileSync(this.logPath, line, 'utf-8');

    if (this.exportLogPath) {
      try {
        fs.appendFileSync(this.exportLogPath, line, 'utf-8');
      } catch (err) {
        console.warn(`[browser-pilot] Failed to write to export log: ${err}`);
      }
    }
  }

  /**
   * Get the export log path (if configured)
   */
  getExportLogPath(): string | null {
    return this.exportLogPath;
  }

  /**
   * Log a command execution
   */
  logCommand(
    cmd: string,
    args: Record<string, unknown>,
    result: { success: boolean; error?: string; hints?: FailureHint[] },
    durationMs: number,
    screenshotFile?: string
  ): void {
    this.log({
      type: 'command',
      cmd,
      args,
      status: result.success ? 'success' : 'failed',
      durationMs,
      error: result.error,
      hints: result.hints,
      screenshotFile,
    });
  }

  /**
   * Log an error
   */
  logError(error: Error, context?: Record<string, unknown>): void {
    this.log({
      type: 'error',
      error: error.message,
      args: context,
    });
  }

  /**
   * Get the log file path
   */
  getLogPath(): string {
    return this.logPath;
  }

  /**
   * Get log statistics
   */
  getLogStats(): LogStats {
    if (!fs.existsSync(this.logPath)) {
      return { entries: 0, size: 0 };
    }

    const stat = fs.statSync(this.logPath);
    const entries = this.countEntries();

    let first: string | undefined;
    let last: string | undefined;

    if (entries > 0) {
      const lines = fs.readFileSync(this.logPath, 'utf-8').trim().split('\n');
      const firstEntry = this.parseLine(lines[0]);
      const lastEntry = this.parseLine(lines[lines.length - 1]);
      first = firstEntry?.ts;
      last = lastEntry?.ts;
    }

    return {
      entries,
      size: stat.size,
      first,
      last,
    };
  }

  /**
   * Get the last n log entries
   */
  tailLog(n: number): LogEntry[] {
    if (!fs.existsSync(this.logPath)) {
      return [];
    }

    const content = fs.readFileSync(this.logPath, 'utf-8').trim();
    if (!content) {
      return [];
    }

    const lines = content.split('\n');
    const startIndex = Math.max(0, lines.length - n);
    const result: LogEntry[] = [];

    for (let i = startIndex; i < lines.length; i++) {
      const entry = this.parseLine(lines[i]);
      if (entry) {
        result.push(entry);
      }
    }

    return result;
  }

  /**
   * Count entries in the log file
   */
  private countEntries(): number {
    if (!fs.existsSync(this.logPath)) {
      return 0;
    }

    const content = fs.readFileSync(this.logPath, 'utf-8').trim();
    if (!content) {
      return 0;
    }

    return content.split('\n').length;
  }

  /**
   * Parse a single log line
   */
  private parseLine(line: string | undefined): LogEntry | null {
    if (!line) {
      return null;
    }

    try {
      const event = JSON.parse(line) as CanonicalTraceEvent;
      return this.traceToCompatibilityEntry(event);
    } catch {
      return null;
    }
  }

  private compatibilityEntryToTrace(entry: LogEntry): CanonicalTraceEvent {
    if (entry.type === 'command') {
      return normalizeTraceEvent({
        traceId: `cmd-${entry.seq}`,
        sessionId: this.sessionId,
        ts: entry.ts,
        channel: 'action',
        event: entry.status === 'failed' ? 'action.failed' : 'action.succeeded',
        severity: entry.status === 'failed' ? 'error' : 'info',
        summary: `${entry.cmd ?? 'command'}${entry.selectorUsed ? ` ${entry.selectorUsed}` : ''}`,
        data: {
          cmd: entry.cmd ?? null,
          args: entry.args ?? {},
          durationMs: entry.durationMs ?? null,
          error: entry.error ?? null,
          hints: entry.hints ?? [],
          screenshotFile: entry.screenshotFile ?? null,
          legacy: entry,
        },
        selectorUsed: entry.selectorUsed,
        url: entry.urlAfter ?? entry.urlBefore,
      });
    }

    if (entry.type === 'error') {
      return normalizeTraceEvent({
        traceId: `err-${entry.seq}`,
        sessionId: this.sessionId,
        ts: entry.ts,
        channel: 'runtime',
        event: 'runtime.exception',
        severity: 'error',
        summary: entry.error ?? 'Session error',
        data: {
          args: entry.args ?? {},
          legacy: entry,
        },
      });
    }

    return normalizeTraceEvent({
      traceId: `evt-${entry.seq}`,
      sessionId: this.sessionId,
      ts: entry.ts,
      channel: 'session',
      event: entry.cmd ?? 'session.event',
      severity: entry.status === 'failed' ? 'error' : 'info',
      summary: entry.cmd ?? 'Session event',
      data: {
        args: entry.args ?? {},
        status: entry.status ?? null,
        legacy: entry,
      },
      url: entry.urlAfter ?? entry.urlBefore,
    });
  }

  private traceToCompatibilityEntry(event: CanonicalTraceEvent): LogEntry {
    const legacy = event.data['legacy'];
    if (legacy && typeof legacy === 'object') {
      return legacy as LogEntry;
    }

    return {
      seq: this.seq,
      ts: event.ts,
      type: event.severity === 'error' ? 'error' : event.channel === 'action' ? 'command' : 'event',
      cmd: event.event,
      args: event.data,
      status:
        event.event === 'action.failed'
          ? 'failed'
          : event.event === 'action.succeeded'
            ? 'success'
            : undefined,
      selectorUsed: event.selectorUsed,
      urlAfter: event.url,
      error: event.severity === 'error' ? event.summary : undefined,
    };
  }
}

// Cache of loggers by session ID (includes export path in cache key)
const loggerCache = new Map<string, SessionLogger>();

/**
 * Get a session logger (cached)
 * @param sessionId - The session ID
 * @param exportLogPath - Optional export log path for dual-write
 */
export function getSessionLogger(sessionId: string, exportLogPath?: string): SessionLogger {
  // Cache key includes export path to handle different export configs
  const cacheKey = exportLogPath ? `${sessionId}:${exportLogPath}` : sessionId;
  let logger = loggerCache.get(cacheKey);
  if (!logger) {
    logger = new SessionLogger(sessionId, exportLogPath);
    loggerCache.set(cacheKey, logger);
  }
  return logger;
}
