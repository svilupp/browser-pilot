import type { CDPErrorData } from '../cdp/protocol.ts';

/**
 * Daemon protocol types
 *
 * The daemon speaks newline-delimited JSON over a Unix domain socket.
 * The protocol mirrors CDP's shape so the daemon acts as a transparent proxy.
 */

/** Request from CLI client → Daemon */
export interface DaemonRequest {
  /** Unique request ID for correlation */
  id: number;
  /** CDP method to execute */
  method: string;
  /** CDP params */
  params?: Record<string, unknown>;
  /** Override sessionId (null = browser-level, undefined = use attached session) */
  sessionId?: string | null;
}

/** Response from Daemon → CLI client */
export interface DaemonResponse {
  /** Matching request ID */
  id: number;
  /** CDP result (on success) */
  result?: unknown;
  /** Structured CDP-style error payload (on failure) */
  error?: CDPErrorData;
}

/** Unsolicited event from Daemon → CLI client */
export interface DaemonEvent {
  /** CDP event method name */
  method: string;
  /** CDP event params */
  params: Record<string, unknown>;
  /**
   * Flat session the event belongs to (undefined = browser-level / default
   * session). Mirrors CDP's top-level `sessionId` so the CLI's CDP client
   * parses it back into `event.sessionId` and routes session-scoped events
   * (e.g. OOPIF child sessions) correctly over the daemon fast-path.
   */
  sessionId?: string;
}

/** Info stored in the session JSON to locate the daemon */
export interface DaemonInfo {
  /** Unix socket path for daemon communication */
  socketPath: string;
  /** Daemon process PID */
  pid: number;
  /** Attached CDP session ID for the persistent target, if available */
  cdpSessionId?: string;
  /** Timestamp when daemon was started */
  startedAt: string;
}

/** Maximum daemon socket age in milliseconds (60 minutes) */
export const DAEMON_MAX_AGE_MS = 60 * 60 * 1000;

/** Timeout for CLI to connect to daemon socket (ms) */
export const DAEMON_CONNECT_TIMEOUT_MS = 500;

/** Default idle timeout before daemon self-exits (ms) — 60 minutes */
export const DAEMON_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** Heartbeat interval (ms) — how often daemon updates session file */
export const DAEMON_HEARTBEAT_INTERVAL_MS = 30_000;

/** How long bp connect waits for daemon to become ready (ms) */
export const DAEMON_READY_TIMEOUT_MS = 3000;

/** Daemon log levels */
export type DaemonLogLevel = 'info' | 'warn' | 'error' | 'debug';
