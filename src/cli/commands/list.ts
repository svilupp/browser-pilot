/**
 * List command - List all sessions
 *
 * Options:
 *   --log-path        Show log file path for session
 *   --log-tail [n]    Show last n log entries (default: 20)
 *   --info            Show detailed session info with log stats
 */

import { output } from '../index.ts';
import { getDefaultSession, listSessions, loadSession, type SessionData } from '../session.ts';
import { getSessionLogger, type LogEntry } from '../session-logger.ts';

interface ListOptions {
  logPath?: boolean;
  logTail?: number;
  info?: boolean;
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

  if (globalOptions.output === 'json') {
    output(sessions, 'json');
    return;
  }

  if (sessions.length === 0) {
    console.log('No active sessions.');
    console.log('Run "bp connect" to create a new session.');
    return;
  }

  console.log('Active Sessions:\n');

  for (const session of sessions) {
    const age = getAge(new Date(session.lastActivity));
    console.log(`  ${session.id}`);
    console.log(`    Provider: ${session.provider}`);
    console.log(`    URL: ${session.currentUrl}`);
    console.log(`    Last activity: ${age}`);
    console.log('');
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
