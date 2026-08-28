/**
 * Close command - Close a browser session
 *
 * Detaches the logical target and deletes the session. Browser-scoped local
 * daemons remain alive for reuse; provider-owned daemons are stopped when the
 * session owns the last reference.
 */

import { daemonControlMatches } from '../../daemon/control.ts';
import { isDaemonAlive, stopDaemon } from '../../daemon/lifecycle.ts';
import {
  countSessionReferences,
  endpointFingerprint,
  readDaemonDescriptor,
  removeDaemonDescriptor,
} from '../../daemon/registry.ts';
import { output } from '../output.ts';
import { deleteSession, getDefaultSession, loadSession, type SessionData } from '../session.ts';

const CLOSE_HELP = `
bp close - Close a browser session

Usage:
  bp close [session-id]

Global options:
  -s, --session <id>   Session to close (default: most recent)
  --json               Output JSON
  --pretty             Output readable text (default)
  --debug              Enable CDP transport debugging
  -h, --help           Show this help

Examples:
  bp close                # Close the most recent session
  bp close dev            # Close session named "dev"
  bp close -s dev --json  # Close session, output as JSON
`.trimEnd();

async function detachDaemonTarget(session: SessionData): Promise<void> {
  if (!session.daemon?.socketPath || !session.daemon.cdpSessionId) return;

  let closeClient: (() => Promise<void>) | undefined;
  try {
    const { createDaemonTransport } = await import('../../daemon/transport.ts');
    const { createCDPClientFromTransport } = await import('../../cdp/client.ts');
    const transport = await createDaemonTransport(session.daemon.socketPath);
    const cdp = createCDPClientFromTransport(transport);
    closeClient = () => cdp.close();
    await cdp.send('daemon.detach', { sessionId: session.daemon.cdpSessionId }, null);
  } catch {
    // Closing a stale/dead daemon is still successful; cleanup below removes
    // the local session and any reachable daemon state.
  } finally {
    await closeClient?.().catch(() => {});
  }
}

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

  // A browser-scoped local daemon is the connection owner, not the lifetime of
  // one logical session. Keep it alive after the last local session closes so
  // the next connect can reuse the same browser WebSocket and consent grant.
  // Provider-owned daemons retain their provider-specific close semantics.
  let daemonStopped = false;
  const sharedDaemon =
    session.transport?.mode === 'daemon' &&
    !!session.transport.daemonId &&
    (await countSessionReferences(session.transport.daemonId)) > 1;
  const keepLocalDaemon =
    session.provider === 'generic' &&
    session.transport?.mode === 'daemon' &&
    !!session.transport.daemonId;
  const daemonDescriptor =
    session.transport?.mode === 'daemon' && session.transport.daemonId
      ? await readDaemonDescriptor(session.transport.daemonId)
      : null;
  const daemonOwner = daemonDescriptor ?? session.daemon;
  const sharedTargetAttachment =
    session.transport?.mode === 'daemon' &&
    !!session.transport.daemonId &&
    !!session.daemon?.cdpSessionId &&
    (await countSessionReferences(session.transport.daemonId, session.daemon.cdpSessionId)) > 1;
  if (session.daemon && !sharedTargetAttachment) {
    await detachDaemonTarget(session);
  }
  if (daemonOwner && !sharedDaemon && !keepLocalDaemon) {
    try {
      if (isDaemonAlive(daemonOwner.pid)) {
        const identityMatches = await daemonControlMatches({
          socketPath: daemonOwner.socketPath,
          ...(session.transport?.mode === 'daemon' && session.transport.daemonId
            ? { daemonId: session.transport.daemonId }
            : {}),
          endpointFingerprint:
            daemonDescriptor?.endpointFingerprint ?? endpointFingerprint(session.wsUrl),
        });
        if (!identityMatches) {
          throw new Error(
            `Refusing to signal PID ${daemonOwner.pid}: the daemon control socket did not prove ownership`
          );
        }
        daemonStopped = await stopDaemon(daemonOwner.pid);
      }
    } catch (error) {
      if (isDaemonAlive(daemonOwner.pid)) throw error;
      // Daemon exited while being checked; continue with cleanup.
    }

    // Clean up socket file
    try {
      const fsPromises = await import('node:fs/promises');
      await fsPromises.unlink(daemonOwner.socketPath).catch(() => {});
    } catch {
      // Ignore
    }
  }
  if (
    !sharedDaemon &&
    !keepLocalDaemon &&
    session.transport?.mode === 'daemon' &&
    session.transport.daemonId
  ) {
    await removeDaemonDescriptor(session.transport.daemonId, daemonDescriptor?.pid);
  }

  // Delete session file
  await deleteSession(session.id, { preserveDaemonRuntime: keepLocalDaemon });

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
