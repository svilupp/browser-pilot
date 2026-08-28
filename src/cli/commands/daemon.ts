/**
 * Daemon command - View and manage daemon processes for sessions
 */

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { daemonControlMatches } from '../../daemon/control.ts';
import { clearDaemonFromSession, isDaemonAlive, stopDaemon } from '../../daemon/lifecycle.ts';
import {
  endpointFingerprint,
  listDaemonDescriptors,
  readDaemonDescriptor,
  removeOwnedDaemonDescriptor,
} from '../../daemon/registry.ts';
import { output } from '../output.ts';
import {
  getDefaultSession,
  getSessionFilePath,
  listSessions,
  loadSession,
  type SessionData,
} from '../session.ts';

const SESSION_DIR = join(homedir(), '.browser-pilot', 'sessions');

const DAEMON_HELP = `
bp daemon - Manage daemon processes for browser sessions

Usage:
  bp daemon <subcommand> [options]

Subcommands:
  list      List browser-scoped daemons, including daemons without logical sessions
  status    Show daemon status for a session
  stop      Stop the daemon for a session
  logs      Show daemon log output

Options:
  -n, --lines <n>      Number of log lines to show (default: 50)
  --daemon-id <id>     Address a browser-scoped daemon without a logical session
  --force              Signal an unresponsive registered PID without identity proof

Global options:
  -s, --session <id>   Target session (default: most recent)
  --json               Output JSON
  --pretty             Output readable text (default)
  -h, --help           Show this help

Examples:
  bp daemon status                   # Daemon status for default session
  bp daemon stop -s dev              # Stop daemon for session "dev"
  bp daemon stop --daemon-id <id>    # Stop a daemon after its last session closed
  bp daemon logs -s dev -n 100       # Last 100 daemon log lines
`.trimEnd();

interface DaemonOptions {
  lines?: number;
  daemonId?: string;
  force?: boolean;
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
    } else if (arg === '--daemon-id') {
      options.daemonId = args[++i];
      if (!options.daemonId) throw new Error('--daemon-id requires a value');
    } else if (arg === '--force') {
      options.force = true;
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
    case 'list': {
      const daemons = await listDaemonDescriptors();
      output(
        {
          daemons: daemons.map((descriptor) => ({
            id: descriptor.id,
            pid: descriptor.pid,
            state: isDaemonAlive(descriptor.pid) ? 'running' : 'dead',
            socketPath: descriptor.socketPath,
            startedAt: descriptor.startedAt,
          })),
        },
        globalOptions.format
      );
      return;
    }

    case 'status': {
      const session = daemonOptions.daemonId ? null : await getSession(globalOptions);
      const selectedDaemonId =
        daemonOptions.daemonId ??
        (session?.transport?.mode === 'daemon' ? session.transport.daemonId : undefined);
      const descriptor = selectedDaemonId ? await readDaemonDescriptor(selectedDaemonId) : null;
      const daemonInfo = descriptor ?? session?.daemon;

      if (!daemonInfo) {
        output(
          {
            sessionId: session?.id,
            daemon: 'not running',
            message: 'No daemon configured for this session. Use "bp connect" to start one.',
          },
          globalOptions.format
        );
        return;
      }

      const alive = isDaemonAlive(daemonInfo.pid);
      let lastHeartbeat = session?.daemon?.lastHeartbeat ?? 'none';
      if (daemonInfo.heartbeatPath) {
        try {
          lastHeartbeat = (
            await import('node:fs/promises').then((fs) =>
              fs.readFile(daemonInfo.heartbeatPath!, 'utf8')
            )
          ).trim();
        } catch {
          // The sidecar may not exist during the first startup milliseconds.
        }
      }
      let responsive = false;
      if (alive) {
        responsive = await daemonControlMatches({
          socketPath: daemonInfo.socketPath,
          ...(selectedDaemonId ? { daemonId: selectedDaemonId } : {}),
          ...(descriptor?.endpointFingerprint
            ? { endpointFingerprint: descriptor.endpointFingerprint }
            : session?.wsUrl
              ? { endpointFingerprint: endpointFingerprint(session.wsUrl) }
              : {}),
        });
      }
      const age = Date.now() - new Date(daemonInfo.startedAt).getTime();
      const ageMins = Math.floor(age / 60000);

      output(
        {
          sessionId: session?.id,
          daemonId: descriptor?.id,
          daemon: !alive ? 'dead' : responsive ? 'running' : 'unresponsive',
          responsive,
          pid: daemonInfo.pid,
          socketPath: daemonInfo.socketPath,
          startedAt: daemonInfo.startedAt,
          uptime: `${ageMins}m`,
          lastHeartbeat,
        },
        globalOptions.format
      );
      return;
    }

    case 'stop': {
      const session = daemonOptions.daemonId ? null : await getSession(globalOptions);
      const selectedDaemonId =
        daemonOptions.daemonId ??
        (session?.transport?.mode === 'daemon' ? session.transport.daemonId : undefined);
      const descriptor = selectedDaemonId ? await readDaemonDescriptor(selectedDaemonId) : null;
      const daemonInfo = descriptor ?? session?.daemon;

      if (!daemonInfo) {
        output(
          { sessionId: session?.id, message: 'No matching daemon is registered' },
          globalOptions.format
        );
        return;
      }

      const daemonId =
        descriptor?.id ??
        (session?.transport?.mode === 'daemon' ? session.transport.daemonId : undefined);
      const alive = isDaemonAlive(daemonInfo.pid);
      const identityMatches =
        !alive ||
        (await daemonControlMatches({
          socketPath: daemonInfo.socketPath,
          ...(daemonId ? { daemonId } : {}),
          ...(descriptor?.endpointFingerprint
            ? { endpointFingerprint: descriptor.endpointFingerprint }
            : session?.wsUrl
              ? { endpointFingerprint: endpointFingerprint(session.wsUrl) }
              : {}),
        }));
      if (alive && !identityMatches && !daemonOptions.force) {
        throw new Error(
          `Refusing to signal PID ${daemonInfo.pid}: the daemon control socket did not prove ownership. ` +
            'Retry with --force only after verifying the PID.'
        );
      }
      const stopped = await stopDaemon(daemonInfo.pid);
      if (daemonId) {
        for (const referencedSession of await listSessions()) {
          if (
            referencedSession.transport?.mode === 'daemon' &&
            referencedSession.transport.daemonId === daemonId
          ) {
            await clearDaemonFromSession(
              getSessionFilePath(referencedSession.id),
              referencedSession.daemon ?? { pid: daemonInfo.pid }
            );
          }
        }
        await removeOwnedDaemonDescriptor(daemonId, daemonInfo.pid).catch(() => false);
      } else if (session) {
        await clearDaemonFromSession(getSessionFilePath(session.id), session.daemon ?? undefined);
      }

      // Clean up socket file
      try {
        const fsPromises = await import('node:fs/promises');
        await fsPromises.unlink(daemonInfo.socketPath).catch(() => {});
      } catch {
        // Ignore
      }

      output(
        {
          sessionId: session?.id,
          daemonId,
          message: stopped ? 'Daemon stopped' : 'Daemon was already dead',
          pid: daemonInfo.pid,
        },
        globalOptions.format
      );
      return;
    }

    case 'logs': {
      const session = daemonOptions.daemonId ? null : await getSession(globalOptions);
      const selectedDaemonId =
        daemonOptions.daemonId ??
        (session?.transport?.mode === 'daemon' ? session.transport.daemonId : undefined);
      const descriptor = selectedDaemonId ? await readDaemonDescriptor(selectedDaemonId) : null;
      const logPath = descriptor
        ? join(dirname(descriptor.socketPath), 'daemon.log')
        : join(SESSION_DIR, session!.id, 'daemon.log');

      if (!fs.existsSync(logPath)) {
        output({ sessionId: session?.id, message: 'No daemon log found' }, globalOptions.format);
        return;
      }

      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.trim().split('\n');
      const n = daemonOptions.lines ?? 50;
      const tail = lines.slice(-n);

      if (globalOptions.format === 'json') {
        output({ sessionId: session?.id, daemonId: descriptor?.id, logPath, lines: tail }, 'json');
      } else {
        console.log(
          `Daemon log for ${session ? `session ${session.id}` : `daemon ${descriptor!.id}`} (last ${tail.length} lines):\n`
        );
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
