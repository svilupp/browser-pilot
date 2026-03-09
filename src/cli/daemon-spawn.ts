/**
 * Daemon spawning helper for the CLI.
 *
 * Spawns the daemon as a detached subprocess and waits for it to signal readiness
 * by writing daemon info to the session file.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_READY_TIMEOUT_MS } from '../daemon/types.ts';

/**
 * Spawn a daemon subprocess for a session.
 *
 * The daemon is spawned detached so it survives the parent process exiting.
 * Stdout/stderr are redirected to the daemon log.
 *
 * @returns The child process PID
 */
export function spawnDaemon(sessionId: string, idleTimeoutMs?: number): { pid: number } {
  // Resolve the daemon entry point relative to this file
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const daemonScript = resolve(join(thisDir, '..', 'daemon', 'index.ts'));

  const args = [daemonScript, sessionId];
  if (idleTimeoutMs) {
    args.push('--idle-timeout', String(idleTimeoutMs));
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
  });

  // Unref so the parent can exit without waiting for the daemon
  child.unref();

  if (!child.pid) {
    throw new Error('Failed to spawn daemon process');
  }

  return { pid: child.pid };
}

/**
 * Wait for the daemon to become ready by polling the session file
 * for the `daemon` field.
 *
 * @returns true if daemon is ready, false if timeout
 */
export async function waitForDaemonReady(
  sessionFilePath: string,
  expectedPid: number,
  timeoutMs: number = DAEMON_READY_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 100;

  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(sessionFilePath, 'utf-8');
      const session = JSON.parse(raw);
      if (session.daemon?.pid === expectedPid && session.daemon?.socketPath) {
        return true;
      }
    } catch {
      // File might not be ready yet
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  return false;
}
