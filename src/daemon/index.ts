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

import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createCDPClient } from '../cdp/client.ts';
import { isRecord } from '../utils/json.ts';
import {
  checkSessionFileExists,
  closeDaemonLog,
  createIdleTimer,
  daemonLog,
  initDaemonLog,
  installSignalHandlers,
  startHeartbeat,
} from './lifecycle.ts';
import { startDaemonServer } from './server.ts';
import { DAEMON_IDLE_TIMEOUT_MS, type DaemonInfo } from './types.ts';

const SESSION_DIR = join(homedir(), '.browser-pilot', 'sessions');

function parseSessionRecord(raw: string): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(raw);
  return isRecord(parsed) ? parsed : null;
}

function parseArgs(args: string[]): { sessionId: string; idleTimeoutMs: number } {
  const id = args[0];
  if (!id) {
    console.error('Usage: daemon <sessionId> [--idle-timeout <ms>]');
    process.exit(1);
  }

  let idleTimeoutMs = DAEMON_IDLE_TIMEOUT_MS;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--idle-timeout' && args[i + 1]) {
      idleTimeoutMs = parseInt(args[i + 1]!, 10);
      i++;
    }
  }

  return { sessionId: id, idleTimeoutMs };
}

function readSessionData(filePath: string): { wsUrl: string; targetId?: string } {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const session = parseSessionRecord(raw);
  if (!session || typeof session['wsUrl'] !== 'string') {
    throw new Error('Invalid session file: missing wsUrl');
  }
  const targetId = typeof session['targetId'] === 'string' ? session['targetId'] : undefined;
  return { wsUrl: session['wsUrl'], targetId };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
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

  // Also schedule a delayed re-check in case of race conditions
  const orphanTimer = checkSessionFileExists(sessionFilePath, 5000);

  // Read session data
  let sessionData: { wsUrl: string; targetId?: string };
  try {
    sessionData = readSessionData(sessionFilePath);
    daemonLog(
      'info',
      `Session loaded: wsUrl=${sessionData.wsUrl}, targetId=${sessionData.targetId ?? 'none'}`
    );
  } catch (err) {
    daemonLog('error', `Failed to read session file: ${err}`);
    closeDaemonLog();
    process.exit(1);
  }

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
      daemonLog('warn', `Failed to attach to target ${sessionData.targetId}: ${err}`);
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
    daemonLog('warn', `Failed to enable some CDP domains: ${err}`);
  }

  // Shutdown procedure (defined early so it can be referenced)
  let isShuttingDown = false;

  // Start the Unix socket server
  const idleTimer = createIdleTimer(() => {
    void shutdown();
  }, idleTimeoutMs);

  const daemonServer = await startDaemonServer(socketPath, cdp, () => {
    idleTimer.reset();
  }).catch((err) => {
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
  };

  try {
    const raw = fs.readFileSync(sessionFilePath, 'utf-8');
    const session = parseSessionRecord(raw);
    if (!session) throw new Error('Invalid session JSON shape');
    session['daemon'] = daemonInfo as unknown as Record<string, unknown>;
    fs.writeFileSync(sessionFilePath, JSON.stringify(session, null, 2));
    daemonLog('info', 'Daemon info written to session file');
  } catch (err) {
    daemonLog('error', `Failed to update session file with daemon info: ${err}`);
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
      daemonLog('error', `Error closing server: ${err}`);
    }

    try {
      await cdp.close();
      daemonLog('info', 'CDP connection closed');
    } catch (err) {
      daemonLog('error', `Error closing CDP: ${err}`);
    }

    // Remove daemon info from session file
    try {
      const raw = fs.readFileSync(sessionFilePath, 'utf-8');
      const session = parseSessionRecord(raw);
      if (!session) return;
      session['daemon'] = undefined;
      fs.writeFileSync(sessionFilePath, JSON.stringify(session, null, 2));
      daemonLog('info', 'Daemon info removed from session file');
    } catch {
      // Session may already be deleted
    }

    daemonLog('info', 'Daemon shutdown complete');
    closeDaemonLog();
    process.exit(0);
  }

  // Install signal handlers
  installSignalHandlers(shutdown);

  daemonLog('info', `Daemon fully operational (idle timeout: ${idleTimeoutMs}ms)`);
}

// Run
void main();
