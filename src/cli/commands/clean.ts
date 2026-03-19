/**
 * Clean command - Remove stale sessions
 */

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDaemonAlive, stopDaemon } from '../../daemon/lifecycle.ts';
import { output } from '../index.ts';
import { deleteSessionFull, listSessions } from '../session.ts';

const SESSION_DIR = join(homedir(), '.browser-pilot', 'sessions');

const CLEAN_HELP = `
bp clean - Remove stale browser sessions

Usage:
  bp clean [options]

Local options:
  --max-age <hours>    Remove sessions older than N hours (default: 24)
  --max-size <size>    Remove oldest sessions until total size < limit (e.g. "100MB", "1GB")
  --dry-run            Show what would be removed without deleting
  --all                Remove all sessions regardless of age

Global options:
  --json               Output JSON
  --pretty             Output readable text (default)
  -h, --help           Show this help

Examples:
  bp clean                   # Remove sessions older than 24 hours
  bp clean --max-age 4       # Remove sessions older than 4 hours
  bp clean --max-size 100MB  # Remove oldest sessions until under 100MB
  bp clean --dry-run         # Preview what would be cleaned
  bp clean --all             # Remove all sessions
`.trimEnd();

interface CleanOptions {
  maxAge?: number; // hours
  maxSize?: number; // bytes
  dryRun?: boolean;
  all?: boolean;
  help?: boolean;
}

/**
 * Parse a human-readable size string (e.g. "100MB", "1GB", "500KB") to bytes
 */
function parseSize(sizeStr: string): number {
  const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)$/i);
  if (!match) {
    throw new Error(`Invalid size format: "${sizeStr}". Use e.g. "100MB", "1GB", "500KB".`);
  }
  const value = parseFloat(match[1]!);
  const unit = match[2]!.toUpperCase();
  const multipliers: Record<string, number> = {
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024,
  };
  return Math.floor(value * multipliers[unit]!);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/**
 * Calculate total size of a session (JSON file + log directory)
 */
function getSessionSize(sessionId: string): number {
  let total = 0;

  // Session JSON file
  const jsonPath = join(SESSION_DIR, `${sessionId}.json`);
  try {
    total += fs.statSync(jsonPath).size;
  } catch {
    /* missing */
  }

  // Session directory (recursive)
  const dirPath = join(SESSION_DIR, sessionId);
  try {
    total += getDirSize(dirPath);
  } catch {
    /* missing */
  }

  return total;
}

/**
 * Recursively compute directory size
 */
function getDirSize(dirPath: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += getDirSize(fullPath);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(fullPath).size;
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* skip */
  }
  return total;
}

function parseCleanArgs(args: string[]): CleanOptions {
  const options: CleanOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--max-age') {
      const value = args[++i];
      options.maxAge = parseInt(value ?? '24', 10);
    } else if (arg === '--max-size') {
      const value = args[++i];
      if (!value) throw new Error('--max-size requires a value (e.g. "100MB")');
      options.maxSize = parseSize(value);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--all') {
      options.all = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    }
  }

  return options;
}

async function deleteSessionWithDaemonStop(session: {
  id: string;
  daemon?: { pid: number } | null;
}): Promise<void> {
  if (session.daemon && isDaemonAlive(session.daemon.pid)) {
    await stopDaemon(session.daemon.pid).catch(() => {});
  }
  await deleteSessionFull(session.id);
}

export async function cleanCommand(
  args: string[],
  globalOptions: { format?: 'json' | 'pretty'; help?: boolean }
): Promise<void> {
  const options = parseCleanArgs(args);

  if (options.help || globalOptions.help) {
    console.log(CLEAN_HELP);
    return;
  }

  // --max-size mode: remove oldest sessions until under limit
  if (options.maxSize !== undefined) {
    const sessions = await listSessions();
    // Sessions are sorted most-recent-first; compute sizes
    const sessionsWithSize = sessions.map((s) => ({
      ...s,
      size: getSessionSize(s.id),
    }));

    let totalSize = sessionsWithSize.reduce((sum, s) => sum + s.size, 0);
    // Remove from oldest (end of list) until under limit
    // Never remove all sessions — always keep at least 1
    const toRemove: typeof sessionsWithSize = [];
    for (let i = sessionsWithSize.length - 1; i > 0 && totalSize > options.maxSize; i--) {
      const session = sessionsWithSize[i]!;
      toRemove.push(session);
      totalSize -= session.size;
    }

    if (toRemove.length === 0) {
      const totalLabel = formatBytes(totalSize);
      if (totalSize > options.maxSize) {
        output(
          {
            message: `Cannot reduce below ${totalLabel} without removing the newest session`,
            cleaned: 0,
            kept: sessionsWithSize[0]?.id,
            withinLimit: false,
          },
          globalOptions.format
        );
        return;
      }
      output(
        { message: `Total size ${totalLabel} is already under limit`, cleaned: 0 },
        globalOptions.format
      );
      return;
    }

    if (options.dryRun) {
      output(
        {
          message: `Would clean ${toRemove.length} session(s)`,
          sessions: toRemove.map((s) => s.id),
          dryRun: true,
        },
        globalOptions.format
      );
      return;
    }

    for (const session of toRemove) {
      await deleteSessionWithDaemonStop(session);
    }

    output(
      totalSize <= options.maxSize
        ? {
            message: `Cleaned ${toRemove.length} session(s)`,
            cleaned: toRemove.length,
            sessions: toRemove.map((s) => s.id),
          }
        : {
            message: `Cleaned ${toRemove.length} session(s), but the newest session still exceeds the size limit`,
            cleaned: toRemove.length,
            sessions: toRemove.map((s) => s.id),
            kept: sessionsWithSize[0]?.id,
            withinLimit: false,
          },
      globalOptions.format
    );
    return;
  }

  // Default --max-age mode
  const maxAgeMs = (options.maxAge ?? 24) * 60 * 60 * 1000; // Default 24 hours
  const now = Date.now();

  const sessions = await listSessions();
  const stale = sessions.filter((s) => {
    if (options.all) return true;
    const age = now - new Date(s.lastActivity).getTime();
    return age > maxAgeMs;
  });

  if (stale.length === 0) {
    output({ message: 'No stale sessions found', cleaned: 0 }, globalOptions.format);
    return;
  }

  if (options.dryRun) {
    output(
      {
        message: `Would clean ${stale.length} session(s)`,
        sessions: stale.map((s) => s.id),
        dryRun: true,
      },
      globalOptions.format
    );
    return;
  }

  for (const session of stale) {
    await deleteSessionWithDaemonStop(session);
  }

  output(
    {
      message: `Cleaned ${stale.length} session(s)`,
      cleaned: stale.length,
      sessions: stale.map((s) => s.id),
    },
    globalOptions.format
  );
}
