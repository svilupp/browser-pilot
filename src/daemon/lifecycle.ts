/**
 * Daemon lifecycle management
 *
 * Handles: centralized logging, heartbeat, idle timeout, signal handling,
 * orphan detection, and session file updates.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireFileLock } from '../runtime/file-lock.ts';
import { isRecord } from '../utils/json.ts';
import type { DaemonLogLevel } from './types.ts';
import { DAEMON_HEARTBEAT_INTERVAL_MS, DAEMON_IDLE_TIMEOUT_MS } from './types.ts';

let logPath: string | null = null;

function parseSessionRecord(raw: string): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(raw);
  return isRecord(parsed) ? parsed : null;
}

let logStream: fs.WriteStream | null = null;

/**
 * Initialize the daemon log file at ~/.browser-pilot/sessions/{sessionId}/daemon.log
 */
export function initDaemonLog(sessionDir: string): void {
  logPath = join(sessionDir, 'daemon.log');
  const dir = dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  logStream = fs.createWriteStream(logPath, { flags: 'a' });
}

/**
 * Write a log entry to the centralized daemon log.
 * All daemon operations are logged here for debugging.
 */
export function daemonLog(level: DaemonLogLevel, message: string): void {
  const entry = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}\n`;

  if (logStream?.writable) {
    logStream.write(entry);
  }

  // Also write to stderr for development / process manager capture
  if (level === 'error' || level === 'warn') {
    process.stderr.write(`[daemon] ${entry}`);
  }
}

/**
 * Close the daemon log stream.
 */
export function closeDaemonLog(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}

/**
 * Get the daemon log file path.
 */
export function getDaemonLogPath(): string | null {
  return logPath;
}

export interface IdleTimer {
  reset(): void;
  stop(): void;
}

/**
 * Create an idle timeout that calls `onIdle` if no activity occurs
 * within the configured timeout period.
 */
export function createIdleTimer(
  onIdle: () => void,
  timeoutMs: number = DAEMON_IDLE_TIMEOUT_MS
): IdleTimer {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function reset(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      daemonLog('info', `Idle timeout reached (${timeoutMs}ms), shutting down`);
      onIdle();
    }, timeoutMs);
  }

  function stop(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  // Start the timer immediately
  reset();

  return { reset, stop };
}

export interface Heartbeat {
  stop(): void;
}

/**
 * Start a heartbeat in a sidecar file. Keeping liveness separate from the
 * logical session JSON prevents heartbeat ticks from racing target/metadata
 * updates performed by CLI commands.
 */
export function startHeartbeat(
  sessionFilePath: string,
  intervalMs: number = DAEMON_HEARTBEAT_INTERVAL_MS
): Heartbeat {
  const heartbeatPath = `${sessionFilePath}.heartbeat`;
  const writeHeartbeat = (): void => {
    try {
      const tempPath = `${heartbeatPath}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(tempPath, `${new Date().toISOString()}\n`, 'utf-8');
      fs.renameSync(tempPath, heartbeatPath);
    } catch (err) {
      daemonLog('warn', `Heartbeat failed to update sidecar: ${err}`);
    }
  };
  writeHeartbeat();
  const timer = setInterval(() => {
    writeHeartbeat();
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * Install signal handlers for graceful daemon shutdown.
 */
export function installSignalHandlers(onShutdown: () => Promise<void>): void {
  let shuttingDown = false;

  const handler = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    daemonLog('info', `Received ${signal}, shutting down gracefully`);
    try {
      await onShutdown();
    } catch (err) {
      daemonLog('error', `Error during shutdown: ${err}`);
    }
    closeDaemonLog();
    process.exit(0);
  };

  process.on('SIGTERM', () => void handler('SIGTERM'));
  process.on('SIGINT', () => void handler('SIGINT'));
}

/**
 * Check if the daemon's session file still exists.
 * If bp connect crashed after spawning, the session file may not exist.
 * The daemon should self-terminate in that case.
 */
export function checkSessionFileExists(
  sessionFilePath: string,
  delayMs: number = 5000,
  alternatePath?: string
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (!fs.existsSync(sessionFilePath) && (!alternatePath || !fs.existsSync(alternatePath))) {
      daemonLog('error', 'Session file does not exist after startup — orphan daemon, exiting');
      closeDaemonLog();
      process.exit(1);
    }
  }, delayMs);
}

/**
 * Check if a daemon process is alive by sending signal 0.
 */
export function isDaemonAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a daemon by PID with SIGTERM.
 * Waits up to `timeoutMs` for the process to exit.
 */
export async function stopDaemon(pid: number, timeoutMs: number = 2000): Promise<boolean> {
  if (!isDaemonAlive(pid)) return true;

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return true; // Already dead
  }

  // Wait for exit
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isDaemonAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }

  // Force kill if still alive
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already dead
  }
  return !isDaemonAlive(pid);
}

/**
 * Remove daemon info from a session file (used on stale cleanup).
 */
export async function clearDaemonFromSession(
  sessionFilePath: string,
  expected?: { pid?: number; socketPath?: string }
): Promise<boolean> {
  let release: (() => Promise<void>) | undefined;
  try {
    const fsPromises = await import('node:fs/promises');
    release = await acquireFileLock(`${sessionFilePath}.lock`);
    const raw = await fsPromises.readFile(sessionFilePath, 'utf-8');
    const session = parseSessionRecord(raw);
    if (!session) return false;
    const daemon = isRecord(session['daemon']) ? session['daemon'] : undefined;
    if (
      expected &&
      (!daemon ||
        (expected.pid !== undefined && daemon['pid'] !== expected.pid) ||
        (expected.socketPath !== undefined && daemon['socketPath'] !== expected.socketPath))
    ) {
      return false;
    }
    session['daemon'] = undefined;
    const tempPath = `${sessionFilePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await fsPromises.open(tempPath, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(session, null, 2)}\n`, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsPromises.rename(tempPath, sessionFilePath);
    return true;
  } catch {
    // Session file may not exist or be corrupted — ignore
    return false;
  } finally {
    await release?.();
  }
}
