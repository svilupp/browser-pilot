/**
 * Session logger for structured event logging
 * Writes JSON Lines format to ~/.browser-pilot/sessions/{sessionId}/log.jsonl
 * Optionally duplicates to a user-specified export path for local convenience
 */

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { FailureHint } from '../browser/types.ts';

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

  constructor(sessionId: string, exportLogPath?: string) {
    const sessionDir = join(SESSION_DIR, sessionId);
    this.logPath = join(sessionDir, 'log.jsonl');

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
   * Log a raw entry (writes to both core and export logs)
   */
  log(entry: Omit<LogEntry, 'seq' | 'ts'>): void {
    const fullEntry: LogEntry = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      ...entry,
    };

    const line = `${JSON.stringify(fullEntry)}\n`;

    // Always write to core log
    fs.appendFileSync(this.logPath, line, 'utf-8');

    // Also write to export log if configured
    if (this.exportLogPath) {
      try {
        fs.appendFileSync(this.exportLogPath, line, 'utf-8');
      } catch (err) {
        // Log export failure but don't break core functionality
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
    durationMs: number
  ): void {
    this.log({
      type: 'command',
      cmd,
      args,
      status: result.success ? 'success' : 'failed',
      durationMs,
      error: result.error,
      hints: result.hints,
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
      return JSON.parse(line) as LogEntry;
    } catch {
      return null;
    }
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
