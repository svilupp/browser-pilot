/**
 * Close command - Close a browser session
 *
 * Stops the daemon (if running) before closing the browser connection
 * and deleting the session.
 */

import { isDaemonAlive, stopDaemon } from '../../daemon/lifecycle.ts';
import { connect } from '../../index.ts';
import { output } from '../index.ts';
import { deleteSession, getDefaultSession, loadSession, type SessionData } from '../session.ts';

const CLOSE_HELP = `
bp close - Close a browser session

Usage:
  bp close [session-id]

Options:
  -s, --session <id>   Session to close (default: most recent)
  -f, --format <fmt>   Output format: json | pretty (default: pretty)
  --json               Alias for -f json
  --trace              Enable debug tracing
  -h, --help           Show this help

Examples:
  bp close                # Close the most recent session
  bp close dev            # Close session named "dev"
  bp close -s dev --json  # Close session, output as JSON
`.trimEnd();

export async function closeCommand(
  args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  if (globalOptions.help) {
    console.log(CLOSE_HELP);
    return;
  }

  // Get session
  let session: SessionData | null;
  if (globalOptions.session) {
    session = await loadSession(globalOptions.session);
  } else if (args[0]) {
    session = await loadSession(args[0]);
  } else {
    session = await getDefaultSession();
    if (!session) {
      throw new Error('No session found. Specify a session ID or run "bp list" to see sessions.');
    }
  }

  // Stop daemon if running
  let daemonStopped = false;
  if (session.daemon) {
    try {
      if (isDaemonAlive(session.daemon.pid)) {
        daemonStopped = await stopDaemon(session.daemon.pid);
      }
    } catch {
      // Daemon may already be dead, continue with cleanup
    }

    // Clean up socket file
    try {
      const fsPromises = await import('node:fs/promises');
      await fsPromises.unlink(session.daemon.socketPath).catch(() => {});
    } catch {
      // Ignore
    }
  }

  try {
    // Try to connect and close the browser
    const browser = await connect({
      provider: session.provider,
      wsUrl: session.wsUrl,
      debug: globalOptions.trace,
    });

    await browser.close();
  } catch {
    // Browser might already be closed, that's ok
  }

  // Delete session file
  await deleteSession(session.id);

  output(
    {
      success: true,
      sessionId: session.id,
      message: 'Session closed',
      daemonStopped: daemonStopped || undefined,
    },
    globalOptions.format
  );
}
