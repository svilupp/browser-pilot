/**
 * Clean command - Remove stale sessions
 */

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { daemonControlMatches } from '../../daemon/control.ts';
import { isDaemonAlive, stopDaemon } from '../../daemon/lifecycle.ts';
import {
  cleanStaleDaemonLocks,
  countSessionReferences,
  endpointFingerprint,
  listDaemonDescriptors,
  readDaemonDescriptor,
  removeDaemonDescriptor,
} from '../../daemon/registry.ts';
import { output } from '../output.ts';
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
  wsUrl: string;
  daemon?: { pid: number; socketPath: string } | null;
  transport?: { mode: 'daemon' | 'direct'; daemonId?: string };
}): Promise<void> {
  const shared =
    session.transport?.mode === 'daemon' &&
    !!session.transport.daemonId &&
    (await countSessionReferences(session.transport.daemonId)) > 1;
  const descriptor =
    session.transport?.mode === 'daemon' && session.transport.daemonId
      ? await readDaemonDescriptor(session.transport.daemonId)
      : null;
  const ownedPid = descriptor?.pid ?? session.daemon?.pid;
  const ownerAlive = !!ownedPid && isDaemonAlive(ownedPid);
  const identityMatches =
    !ownerAlive ||
    (await daemonControlMatches({
      socketPath: descriptor?.socketPath ?? session.daemon!.socketPath,
      ...(session.transport?.mode === 'daemon' && session.transport.daemonId
        ? { daemonId: session.transport.daemonId }
        : {}),
      endpointFingerprint: descriptor?.endpointFingerprint ?? endpointFingerprint(session.wsUrl),
    }));
  if (!shared && ownerAlive && identityMatches) {
    await stopDaemon(ownedPid).catch(() => {});
  }
  if (!shared && session.transport?.mode === 'daemon' && session.transport.daemonId) {
    await removeDaemonDescriptor(session.transport.daemonId, descriptor?.pid);
  }
  // The daemon socket/log may live under the bootstrap session directory even
  // when another logical session still references it. Never unlink that
  // runtime while the shared browser owner is active.
  await deleteSessionFull(session.id, {
    preserveDaemonRuntime: shared || (ownerAlive && !identityMatches),
  });
}

async function cleanupRegisteredDaemons(
  includeHealthy: boolean,
  dryRun: boolean
): Promise<{ daemons: string[]; locks: string[] }> {
  const selected: string[] = [];
  for (const descriptor of await listDaemonDescriptors()) {
    // A missing socket plus a live PID is not enough proof to signal the PID;
    // it may have been reused by an unrelated process. `--all` is the explicit
    // operator override. Automatic cleanup handles only dead owners.
    const stale = !isDaemonAlive(descriptor.pid);
    if (!includeHealthy && !stale) continue;
    selected.push(descriptor.id);
    if (dryRun) continue;
    const ownerAlive = isDaemonAlive(descriptor.pid);
    const identityMatches =
      !ownerAlive ||
      (await daemonControlMatches({
        socketPath: descriptor.socketPath,
        daemonId: descriptor.id,
        endpointFingerprint: descriptor.endpointFingerprint,
      }));
    if (ownerAlive && identityMatches) {
      await stopDaemon(descriptor.pid).catch(() => false);
    }
    if (ownerAlive && !identityMatches) {
      // Drop the stale registry pointer, but never unlink or signal runtime
      // state that did not prove it belongs to this descriptor.
      await removeDaemonDescriptor(descriptor.id, descriptor.pid);
      continue;
    }
    const fsPromises = await import('node:fs/promises');
    await fsPromises.unlink(descriptor.socketPath).catch(() => {});
    if (descriptor.heartbeatPath) {
      await fsPromises.unlink(descriptor.heartbeatPath).catch(() => {});
    }
    await removeDaemonDescriptor(descriptor.id, descriptor.pid);
    const runtimeDir = resolve(dirname(descriptor.socketPath));
    const sessionsRoot = `${resolve(SESSION_DIR)}${sep}`;
    if (includeHealthy && runtimeDir.startsWith(sessionsRoot)) {
      await fsPromises.rm(runtimeDir, { recursive: true, force: true });
    }
  }
  const locks = dryRun ? [] : await cleanStaleDaemonLocks();
  return { daemons: selected, locks };
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

  const registryCleanup = await cleanupRegisteredDaemons(
    options.all === true,
    options.dryRun === true
  );
  const cleanedDaemons = registryCleanup.daemons;
  const cleanedLocks = registryCleanup.locks;
  const registryDetails = {
    ...(cleanedDaemons.length > 0 ? { daemons: cleanedDaemons } : {}),
    ...(cleanedLocks.length > 0 ? { locks: cleanedLocks } : {}),
  };

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
        {
          message: `Total size ${totalLabel} is already under limit`,
          cleaned: 0,
          ...registryDetails,
        },
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
          ...registryDetails,
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
            ...registryDetails,
          }
        : {
            message: `Cleaned ${toRemove.length} session(s), but the newest session still exceeds the size limit`,
            cleaned: toRemove.length,
            sessions: toRemove.map((s) => s.id),
            kept: sessionsWithSize[0]?.id,
            withinLimit: false,
            ...registryDetails,
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
    output(
      {
        message:
          cleanedDaemons.length + cleanedLocks.length > 0
            ? 'Cleaned stale daemon registry state; no stale sessions found'
            : 'No stale sessions found',
        cleaned: 0,
        ...registryDetails,
      },
      globalOptions.format
    );
    return;
  }

  if (options.dryRun) {
    output(
      {
        message: `Would clean ${stale.length} session(s)`,
        sessions: stale.map((s) => s.id),
        dryRun: true,
        ...registryDetails,
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
      ...registryDetails,
    },
    globalOptions.format
  );
}
