/**
 * Daemon command - View and manage daemon processes for sessions
 */

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clearDaemonFromSession, isDaemonAlive, stopDaemon } from '../../daemon/lifecycle.ts';
import { output } from '../index.ts';
import {
  getDefaultSession,
  getSessionFilePath,
  loadSession,
  type SessionData,
} from '../session.ts';

const SESSION_DIR = join(homedir(), '.browser-pilot', 'sessions');

const DAEMON_HELP = `
bp daemon - Manage daemon processes for browser sessions

Usage:
  bp daemon <subcommand> [options]

Subcommands:
  status    Show daemon status for a session
  stop      Stop the daemon for a session
  logs      Show daemon log output

Options:
  -s, --session <id>   Target session (default: most recent)
  -f, --format <fmt>   Output format: json | pretty (default: pretty)
  --json               Alias for -f json
  -n, --lines <n>      Number of log lines to show (default: 50)
  -h, --help           Show this help

Examples:
  bp daemon status                   # Daemon status for default session
  bp daemon stop -s dev              # Stop daemon for session "dev"
  bp daemon logs -s dev -n 100       # Last 100 daemon log lines
`.trimEnd();

interface DaemonOptions {
  lines?: number;
}

function parseDaemonArgs(args: string[]): {
  subcommand: string | undefined;
  options: DaemonOptions;
} {
  const options: DaemonOptions = {};
  let subcommand: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-n' || arg === '--lines') {
      options.lines = parseInt(args[++i] ?? '50', 10);
    } else if (!arg.startsWith('-') && !subcommand) {
      subcommand = arg;
    }
  }

  return { subcommand, options };
}

async function getSession(globalOptions: { session?: string }): Promise<SessionData> {
  let session: SessionData | null;
  if (globalOptions.session) {
    session = await loadSession(globalOptions.session);
  } else {
    session = await getDefaultSession();
  }
  if (!session) {
    throw new Error('No session found. Run "bp connect" first or specify with -s.');
  }
  return session;
}

export async function daemonCommand(
  args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  const { subcommand, options: daemonOptions } = parseDaemonArgs(args);

  if (globalOptions.help || !subcommand) {
    console.log(DAEMON_HELP);
    return;
  }

  switch (subcommand) {
    case 'status': {
      const session = await getSession(globalOptions);
      const daemonInfo = session.daemon;

      if (!daemonInfo) {
        output(
          {
            sessionId: session.id,
            daemon: 'not running',
            message: 'No daemon configured for this session. Use "bp connect" to start one.',
          },
          globalOptions.format
        );
        return;
      }

      const alive = isDaemonAlive(daemonInfo.pid);
      const age = Date.now() - new Date(daemonInfo.startedAt).getTime();
      const ageMins = Math.floor(age / 60000);

      output(
        {
          sessionId: session.id,
          daemon: alive ? 'running' : 'dead',
          pid: daemonInfo.pid,
          socketPath: daemonInfo.socketPath,
          startedAt: daemonInfo.startedAt,
          uptime: `${ageMins}m`,
          lastHeartbeat: daemonInfo.lastHeartbeat ?? 'none',
        },
        globalOptions.format
      );
      return;
    }

    case 'stop': {
      const session = await getSession(globalOptions);

      if (!session.daemon) {
        output(
          { sessionId: session.id, message: 'No daemon running for this session' },
          globalOptions.format
        );
        return;
      }

      const stopped = await stopDaemon(session.daemon.pid);
      await clearDaemonFromSession(getSessionFilePath(session.id));

      // Clean up socket file
      try {
        const fsPromises = await import('node:fs/promises');
        await fsPromises.unlink(session.daemon.socketPath).catch(() => {});
      } catch {
        // Ignore
      }

      output(
        {
          sessionId: session.id,
          message: stopped ? 'Daemon stopped' : 'Daemon was already dead',
          pid: session.daemon.pid,
        },
        globalOptions.format
      );
      return;
    }

    case 'logs': {
      const session = await getSession(globalOptions);
      const logPath = join(SESSION_DIR, session.id, 'daemon.log');

      if (!fs.existsSync(logPath)) {
        output({ sessionId: session.id, message: 'No daemon log found' }, globalOptions.format);
        return;
      }

      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.trim().split('\n');
      const n = daemonOptions.lines ?? 50;
      const tail = lines.slice(-n);

      if (globalOptions.format === 'json') {
        output({ sessionId: session.id, logPath, lines: tail }, 'json');
      } else {
        console.log(`Daemon log for session ${session.id} (last ${tail.length} lines):\n`);
        for (const line of tail) {
          console.log(`  ${line}`);
        }
        console.log(`\nLog path: ${logPath}`);
      }
      return;
    }

    default:
      console.error(`Unknown daemon subcommand: ${subcommand}`);
      console.log(DAEMON_HELP);
      process.exit(1);
  }
}
