/**
 * Clean command - Remove stale sessions
 */

import { isDaemonAlive, stopDaemon } from '../../daemon/lifecycle.ts';
import { output } from '../index.ts';
import { deleteSessionFull, listSessions } from '../session.ts';

const CLEAN_HELP = `
bp clean - Remove stale browser sessions

Usage:
  bp clean [options]

Options:
  --max-age <hours>    Remove sessions older than N hours (default: 24)
  --dry-run            Show what would be removed without deleting
  --all                Remove all sessions regardless of age
  -f, --format <fmt>   Output format: json | pretty (default: pretty)
  --json               Alias for -f json
  -h, --help           Show this help

Examples:
  bp clean                # Remove sessions older than 24 hours
  bp clean --max-age 4    # Remove sessions older than 4 hours
  bp clean --dry-run      # Preview what would be cleaned
  bp clean --all          # Remove all sessions
`.trimEnd();

interface CleanOptions {
  maxAge?: number; // hours
  dryRun?: boolean;
  all?: boolean;
  help?: boolean;
}

function parseCleanArgs(args: string[]): CleanOptions {
  const options: CleanOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--max-age') {
      const value = args[++i];
      options.maxAge = parseInt(value ?? '24', 10);
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

export async function cleanCommand(
  args: string[],
  globalOptions: { format?: 'json' | 'pretty'; help?: boolean }
): Promise<void> {
  const options = parseCleanArgs(args);

  if (options.help || globalOptions.help) {
    console.log(CLEAN_HELP);
    return;
  }

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
    // Stop daemon if running
    if (session.daemon && isDaemonAlive(session.daemon.pid)) {
      await stopDaemon(session.daemon.pid).catch(() => {});
    }
    await deleteSessionFull(session.id);
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
