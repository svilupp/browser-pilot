#!/usr/bin/env bun

/**
 * Daemon entry point — spawned as a detached subprocess by `bp connect`.
 *
 * Usage: bun ./src/daemon/index.ts <sessionId> [--idle-timeout <ms>]
 *
 * The daemon:
 * 1. Reads session data from ~/.browser-pilot/sessions/{sessionId}.json
 * 2. Connects to Chrome via the saved WebSocket URL
 * 3. Attaches to the saved target and enables CDP domains
 * 4. Starts a Unix socket server for CLI clients
 * 5. Updates the session file with daemon info (PID, socket path)
 * 6. Runs until idle timeout, Chrome disconnection, or SIGTERM
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCDPClient } from '../cdp/client.ts';
import { acquireFileLock } from '../runtime/file-lock.ts';
import { isRecord } from '../utils/json.ts';
import {
  checkSessionFileExists,
  clearDaemonFromSession,
  closeDaemonLog,
  createIdleTimer,
  daemonLog,
  initDaemonLog,
  installSignalHandlers,
  startHeartbeat,
} from './lifecycle.ts';
import { endpointFingerprint, removeOwnedDaemonDescriptor } from './registry.ts';
import { startDaemonServer } from './server.ts';
import type { DaemonInfo } from './types.ts';

const SESSION_DIR = join(homedir(), '.browser-pilot', 'sessions');

function parseSessionRecord(raw: string): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(raw);
  return isRecord(parsed) ? parsed : null;
}

function writeSessionRecord(filePath: string, session: Record<string, unknown>): void {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tempPath, 'wx');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(session, null, 2)}\n`, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Temp file may not have been created.
    }
    throw error;
  }
}

function parseArgs(args: string[]): { sessionId: string; idleTimeoutMs?: number } {
  const id = args[0];
  if (!id) {
    console.error('Usage: daemon <sessionId> [--idle-timeout <ms>]');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) {
    throw new Error('Invalid session ID');
  }

  // Daemons are persistent by default. An idle timeout is an explicit opt-in
  // (`--daemon-idle` from the CLI) so a healthy browser connection is not
  // torn down on a clock boundary and forced to prompt again.
  let idleTimeoutMs: number | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--idle-timeout' && args[i + 1]) {
      idleTimeoutMs = parseInt(args[i + 1]!, 10);
      i++;
    }
  }

  return { sessionId: id, idleTimeoutMs };
}

function redactWsUrl(wsUrl: string): string {
  try {
    const parsed = new URL(wsUrl);
    return `${parsed.protocol}//${parsed.host}/…`;
  } catch {
    return '<redacted>';
  }
}

function printHelp(): void {
  console.log('Usage: daemon <sessionId> [--idle-timeout <ms>]');
}

function printVersion(): void {
  if (process.env['npm_package_version']) {
    console.log(process.env['npm_package_version']);
    return;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  for (const packagePath of [
    join(here, 'package.json'),
    join(here, '..', 'package.json'),
    join(here, '..', '..', 'package.json'),
  ]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string') {
        console.log(parsed.version);
        return;
      }
    } catch {
      // Try the next package location; source and bundled layouts differ.
    }
  }
  console.log('unknown');
}

function readSessionData(filePath: string): {
  wsUrl: string;
  targetId?: string;
  daemonId?: string;
} {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const session = parseSessionRecord(raw);
  if (!session || typeof session['wsUrl'] !== 'string') {
    throw new Error('Invalid session file: missing wsUrl');
  }
  const targetId = typeof session['targetId'] === 'string' ? session['targetId'] : undefined;
  const transport = isRecord(session['transport']) ? session['transport'] : undefined;
  const daemonId =
    transport && typeof transport['daemonId'] === 'string' ? transport['daemonId'] : undefined;
  return { wsUrl: session['wsUrl'], targetId, daemonId };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  if (args.includes('--version')) {
    // Keep the standalone entry point side-effect free and useful in package
    // smoke tests without importing or touching a session.
    printVersion();
    return;
  }
  const { sessionId, idleTimeoutMs } = parseArgs(args);

  const sessionDir = join(SESSION_DIR, sessionId);
  const sessionFilePath = join(SESSION_DIR, `${sessionId}.json`);
  const socketPath = join(sessionDir, 'daemon.sock');

  // Initialize logging first so all subsequent ops are logged
  initDaemonLog(sessionDir);
  daemonLog('info', `Daemon starting for session ${sessionId} (PID: ${process.pid})`);

  // Verify session file exists (protect against orphan daemons)
  if (!fs.existsSync(sessionFilePath)) {
    daemonLog('error', `Session file not found: ${sessionFilePath}`);
    closeDaemonLog();
    process.exit(1);
  }

  // Read session data
  let sessionData: { wsUrl: string; targetId?: string; daemonId?: string };
  try {
    sessionData = readSessionData(sessionFilePath);
    daemonLog(
      'info',
      `Session loaded: wsUrl=${redactWsUrl(sessionData.wsUrl)}, targetId=${sessionData.targetId ?? 'none'}`
    );
  } catch (err) {
    daemonLog('error', `Failed to read session file: ${err}`);
    closeDaemonLog();
    process.exit(1);
  }

  // Also schedule a delayed re-check in case of race conditions. A shared
  // browser daemon can outlive its first logical session, so its registry
  // descriptor is an alternate owner marker.
  const descriptorPath = sessionData.daemonId
    ? join(homedir(), '.browser-pilot', 'daemons', `${sessionData.daemonId}.json`)
    : undefined;
  const orphanTimer = checkSessionFileExists(sessionFilePath, 5000, descriptorPath);

  // Connect to Chrome via persistent WebSocket
  const cdp = await createCDPClient(sessionData.wsUrl, { timeout: 30000 }).catch((err) => {
    daemonLog('error', `Failed to connect to Chrome: ${err}`);
    closeDaemonLog();
    process.exit(1);
  });

  daemonLog('info', 'CDP WebSocket connection established');

  // Attach to target if we have one
  let cdpSessionId: string | undefined;
  if (sessionData.targetId) {
    try {
      cdpSessionId = await cdp.attachToTarget(sessionData.targetId);
      daemonLog('info', `Attached to target ${sessionData.targetId} (sessionId: ${cdpSessionId})`);
    } catch (err) {
      daemonLog('warn', `Failed to attach to target ${sessionData.targetId}: ${String(err)}`);
    }
  }

  // Enable CDP domains so clients don't have to
  try {
    await Promise.all([
      cdp.send('Page.enable'),
      cdp.send('DOM.enable'),
      cdp.send('Runtime.enable'),
      cdp.send('Network.enable'),
    ]);
    daemonLog('info', 'CDP domains enabled (Page, DOM, Runtime, Network)');
  } catch (err) {
    daemonLog('warn', `Failed to enable some CDP domains: ${String(err)}`);
  }

  // Shutdown procedure (defined early so it can be referenced)
  let isShuttingDown = false;
  let requestShutdown: (() => void) | undefined;

  // Start the Unix socket server
  const idleTimer = idleTimeoutMs
    ? createIdleTimer(() => {
        void shutdown();
      }, idleTimeoutMs)
    : { reset() {}, stop() {} };

  const daemonServer = await startDaemonServer(
    socketPath,
    cdp,
    () => {
      idleTimer.reset();
    },
    () => requestShutdown?.(),
    {
      ...(sessionData.daemonId ? { daemonId: sessionData.daemonId } : {}),
      endpointFingerprint: endpointFingerprint(sessionData.wsUrl),
    }
  ).catch((err) => {
    daemonLog('error', `Failed to start Unix socket server: ${err}`);
    void cdp.close();
    closeDaemonLog();
    process.exit(1);
  });

  daemonLog('info', `Unix socket server ready at ${socketPath}`);

  // Write daemon info to session file
  const daemonInfo: DaemonInfo = {
    socketPath,
    pid: process.pid,
    cdpSessionId,
    startedAt: new Date().toISOString(),
    heartbeatPath: `${sessionFilePath}.heartbeat`,
  };

  let releaseSessionLock: (() => Promise<void>) | undefined;
  try {
    releaseSessionLock = await acquireFileLock(`${sessionFilePath}.lock`);
    const raw = fs.readFileSync(sessionFilePath, 'utf-8');
    const session = parseSessionRecord(raw);
    if (!session) throw new Error('Invalid session JSON shape');
    session['schemaVersion'] = 1;
    session['daemon'] = { ...daemonInfo };
    writeSessionRecord(sessionFilePath, session);
    daemonLog('info', 'Daemon info written to session file');
  } catch (err) {
    daemonLog('error', `Failed to update session file with daemon info: ${String(err)}`);
  } finally {
    await releaseSessionLock?.();
  }

  // Start heartbeat
  const heartbeat = startHeartbeat(sessionFilePath);

  // Handle Chrome WebSocket disconnection
  cdp.on('Inspector.detached', () => {
    daemonLog('warn', 'Chrome inspector detached');
    void shutdown();
  });

  // Watch for CDP connection loss
  const connectionCheckInterval = setInterval(() => {
    if (!cdp.isConnected) {
      daemonLog('warn', 'CDP connection lost, shutting down');
      void shutdown();
    }
  }, 5000);

  async function shutdown(): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    daemonLog('info', 'Daemon shutting down...');
    clearTimeout(orphanTimer);
    clearInterval(connectionCheckInterval);
    idleTimer.stop();
    heartbeat.stop();

    try {
      await daemonServer.close();
      daemonLog('info', 'Unix socket server closed');
    } catch (err) {
      daemonLog('error', `Error closing server: ${String(err)}`);
    }

    try {
      await cdp.close();
      daemonLog('info', 'CDP connection closed');
    } catch (err) {
      daemonLog('error', `Error closing CDP: ${String(err)}`);
    }

    // A delayed shutdown from an old daemon must not erase metadata or the
    // heartbeat written by a replacement daemon for the same logical session.
    const clearedOwnSession = await clearDaemonFromSession(sessionFilePath, {
      pid: process.pid,
      socketPath,
    });
    if (clearedOwnSession) {
      daemonLog('info', 'Daemon info removed from session file');
    }

    let removedOwnDescriptor = false;
    if (sessionData.daemonId) {
      // Recovery may hold the registry lock while asking this daemon to stop.
      // Shutdown must not block on that lock; the recovery owner will replace
      // or remove the descriptor after this process exits.
      removedOwnDescriptor = await removeOwnedDaemonDescriptor(
        sessionData.daemonId,
        process.pid,
        50
      ).catch(() => false);
    }

    if (clearedOwnSession || removedOwnDescriptor) {
      try {
        fs.unlinkSync(`${sessionFilePath}.heartbeat`);
      } catch {
        // Sidecar may already be gone.
      }
    }

    daemonLog('info', 'Daemon shutdown complete');
    closeDaemonLog();
    process.exit(0);
  }

  requestShutdown = () => {
    void shutdown();
  };

  // Install signal handlers
  installSignalHandlers(shutdown);

  daemonLog(
    'info',
    `Daemon fully operational (idle timeout: ${idleTimeoutMs ? `${idleTimeoutMs}ms` : 'disabled'})`
  );
}

// Run
void main();
