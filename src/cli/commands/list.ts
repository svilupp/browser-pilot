/**
 * List command - List all sessions
 *
 * Options:
 *   --log-path        Show log file path for session
 *   --log-tail [n]    Show last n log entries (default: 20)
 *   --info            Show detailed session info with log stats
 */

import { output } from '../index.ts';
import {
  deleteSessionFull,
  getDefaultSession,
  listSessions,
  loadSession,
  type SessionData,
} from '../session.ts';
import { getSessionLogger, type LogEntry } from '../session-logger.ts';

const HELP = `
bp list - List sessions and view action logs

Usage:
  bp list                          List all active sessions
  bp list -s <id> --info           Detailed session info with log stats
  bp list -s <id> --log-tail [n]   Show last n log entries (default: 20)
  bp list -s <id> --log-path       Print path to session log file (for analysis)

Options:
  -s, --session <id>    Target session (or uses default session)
  --info                Show session details and log statistics
  --log-tail [n]        Show last n action log entries (default: 20)
  --log-path            Print absolute path to log.jsonl file
  -o json, --json       Machine-readable JSON output
  -h, --help            Show this help

Examples:
  bp list                              # See all sessions
  bp list -s voice-agent --log-tail    # Last 20 actions for a session
  bp list -s voice-agent --log-tail 5  # Last 5 actions
  bp list -s voice-agent --log-path    # Get log file path for analysis
  bp list -s voice-agent --info        # Full session details + log stats

  # AI agent debugging workflow:
  cat $(bp list -s voice-agent --log-path)   # Read full action log
`.trimEnd();

interface ListOptions {
  logPath?: boolean;
  logTail?: number;
  info?: boolean;
  help?: boolean;
}

function parseListArgs(args: string[]): ListOptions {
  const options: ListOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--log-path') {
      options.logPath = true;
    } else if (arg === '--log-tail') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        options.logTail = parseInt(next, 10);
        i++;
      } else {
        options.logTail = 20; // default
      }
    } else if (arg === '--info') {
      options.info = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    }
  }

  return options;
}

function formatLogEntry(entry: LogEntry): string {
  const time = new Date(entry.ts).toLocaleTimeString();
  const status = entry.status === 'failed' ? '✗' : entry.status === 'success' ? '✓' : '○';

  if (entry.type === 'command') {
    const dur = entry.durationMs ? `(${entry.durationMs}ms)` : '';
    return `${time} ${status} ${entry.cmd} ${dur}`;
  }
  if (entry.type === 'error') {
    return `${time} ✗ ERROR: ${entry.error}`;
  }
  return `${time} ${entry.type}: ${entry.cmd || ''}`;
}

export async function listCommand(
  args: string[],
  globalOptions: { session?: string; output?: 'json' | 'pretty'; trace?: boolean }
): Promise<void> {
  const listOptions = parseListArgs(args);

  if (listOptions.help) {
    console.log(HELP);
    return;
  }

  // Handle --log-path, --log-tail, --info (require a session)
  if (listOptions.logPath || listOptions.logTail !== undefined || listOptions.info) {
    let session: SessionData | null;
    if (globalOptions.session) {
      session = await loadSession(globalOptions.session);
    } else {
      session = await getDefaultSession();
    }

    if (!session) {
      throw new Error('No session found. Run "bp connect" first or specify with -s.');
    }

    const logger = getSessionLogger(session.id);

    if (listOptions.logPath) {
      console.log(logger.getLogPath());
      return;
    }

    if (listOptions.logTail !== undefined) {
      const entries = logger.tailLog(listOptions.logTail);

      if (globalOptions.output === 'json') {
        output(entries, 'json');
        return;
      }

      if (entries.length === 0) {
        console.log('No log entries.');
        return;
      }

      console.log(`Last ${entries.length} log entries for session ${session.id}:\n`);
      for (const entry of entries) {
        console.log(`  ${formatLogEntry(entry)}`);
      }
      return;
    }

    if (listOptions.info) {
      const stats = logger.getLogStats();

      if (globalOptions.output === 'json') {
        output({ session, logStats: stats }, 'json');
        return;
      }

      console.log(`Session: ${session.id}\n`);
      console.log(`  Provider: ${session.provider}`);
      console.log(`  Created: ${new Date(session.createdAt).toLocaleString()}`);
      console.log(`  Last activity: ${new Date(session.lastActivity).toLocaleString()}`);
      console.log(`  URL: ${session.currentUrl}`);
      if (session.exportLog) {
        console.log(`  Export log: ${session.exportLog}`);
      }
      console.log('');
      console.log('Log Stats:');
      console.log(`  Path: ${logger.getLogPath()}`);
      console.log(`  Entries: ${stats.entries}`);
      console.log(`  Size: ${formatBytes(stats.size)}`);
      if (stats.first) {
        console.log(`  First: ${new Date(stats.first).toLocaleString()}`);
      }
      if (stats.last) {
        console.log(`  Last: ${new Date(stats.last).toLocaleString()}`);
      }
      return;
    }
  }

  // Default: list all sessions
  const sessions = await listSessions();

  // Auto-clean sessions older than 2 days
  const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const stale = sessions.filter((s) => now - new Date(s.lastActivity).getTime() > TWO_DAYS_MS);
  const fresh = sessions.filter((s) => now - new Date(s.lastActivity).getTime() <= TWO_DAYS_MS);

  if (stale.length > 0) {
    for (const s of stale) {
      await deleteSessionFull(s.id);
    }
  }

  if (globalOptions.output === 'json') {
    output(fresh, 'json');
    return;
  }

  if (stale.length > 0) {
    console.log(`Cleaned ${stale.length} stale session(s) (>2 days old).\n`);
  }

  if (fresh.length === 0) {
    console.log('No active sessions.');
    console.log('Run "bp connect" to create a new session.');
    return;
  }

  console.log('Active Sessions:\n');
  console.log('  Tip: bp list -s <name> --log-tail     View action log');
  console.log('       bp list -s <name> --log-path     Get log file path\n');

  const displaySessions = fresh.slice(0, 20);

  for (const session of displaySessions) {
    const age = getAge(new Date(session.lastActivity));
    console.log(`  ${session.id}`);
    console.log(`    Provider: ${session.provider}`);
    console.log(`    URL: ${session.currentUrl}`);
    console.log(`    Last activity: ${age}`);
    console.log('');
  }

  if (fresh.length > 20) {
    console.log(`  (showing 20 of ${fresh.length} sessions)\n`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getAge(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
