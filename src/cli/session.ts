/**
 * Session persistence for CLI
 * Stores session data in ~/.browser-pilot/sessions/
 */

import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DaemonInfo } from '../daemon/types.ts';
import type { ChromeChannel, ResolvedBrowserSource } from '../providers/local-discovery.ts';
import { acquireFileLock } from '../runtime/file-lock.ts';
import type { SetCookieOptions } from '../storage/types.ts';

export type ProviderType = 'browserbase' | 'browserless' | 'browser-use' | 'generic';

export interface SessionData {
  /** Logical session schema; legacy records without this field are migrated on save. */
  schemaVersion?: 1;
  /** Session identifier */
  id: string;
  /** Provider type */
  provider: ProviderType;
  /** WebSocket URL for reconnection */
  wsUrl: string;
  /** Provider-specific session ID (for resumption) */
  providerSessionId?: string;
  /** CDP target ID of the page we're controlling */
  targetId?: string;
  /** Export log path for local duplication (optional) */
  exportLog?: string;
  /** Creation timestamp */
  createdAt: string;
  /** Last activity timestamp */
  lastActivity: string;
  /** Current page URL */
  currentUrl: string;
  /** Additional metadata */
  metadata?: SessionMetadata;
  /** Daemon connection info (present when daemon is running) */
  daemon?: DaemonInfo & { lastHeartbeat?: string };
  /** Explicit transport policy used for this session. */
  transport?:
    | { mode: 'daemon'; daemonId?: string }
    | { mode: 'direct'; reason: 'flag' | 'environment' | 'legacy' };
}

export interface RefCache {
  url: string;
  savedAt: string;
  refMap: Record<string, number>;
}

export interface LogStats {
  entries: number;
  size: number;
  first?: string;
  last?: string;
}

export interface RecordSettings {
  /** Screenshot format. Default: 'webp' */
  format?: 'png' | 'jpeg' | 'webp';
  /** Image quality 0-100 (webp/jpeg only). Default: 40 */
  quality?: number;
  /** Inject visual highlights before capture. Default: true */
  highlights?: boolean;
}

export interface EnvSettings {
  permissions?: string[];
  geolocation?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
  visibility?: 'hidden' | 'visible';
  network?: {
    offline: boolean;
    latency?: number;
  };
  /**
   * Persisted Cloudflare-Access-style auth state, reapplied on every
   * attach/reattach via `applySessionEnvironment()`. See
   * docs/proposals/cloudflare-access-auth.md for the full lifecycle.
   *
   * `extraHeaders.fromEnv` stores environment variable *names*, never
   * resolved secret values — session files are plaintext on disk.
   */
  auth?: {
    extraHeaders?: {
      /** header name -> env var name, resolved at apply time via getEnv() */
      fromEnv?: Record<string, string>;
      /** header name -> literal value (use sparingly; prefer fromEnv for secrets) */
      values?: Record<string, string>;
    };
    /** value and valueFromEnv are mutually exclusive per entry */
    cookies?: (Omit<SetCookieOptions, 'value'> & { value?: string; valueFromEnv?: string })[];
  };
}

export interface SessionMetadata {
  refCache?: RefCache;
  logStats?: LogStats;
  connectionSource?: ResolvedBrowserSource;
  resolvedChannel?: ChromeChannel | 'custom';
  resolvedUserDataDir?: string;
  /** Session-level recording settings (set via `bp connect --record`) */
  record?: RecordSettings;
  env?: EnvSettings;
  [key: string]: unknown;
}

export const SESSION_DIR = join(homedir(), '.browser-pilot', 'sessions');

export function validateSessionId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) {
    throw new Error(
      'Invalid session ID. Use 1-128 letters, numbers, dots, underscores, or hyphens.'
    );
  }
}

/**
 * Get the file path for a session
 */
export function getSessionFilePath(id: string): string {
  validateSessionId(id);
  return join(SESSION_DIR, `${id}.json`);
}

/**
 * Ensure the session directory exists
 */
async function ensureSessionDir(): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.mkdir(SESSION_DIR, { recursive: true });
}

/**
 * Save a session to disk
 */
async function saveSessionUnlocked(session: SessionData): Promise<void> {
  await ensureSessionDir();
  const fs = await import('node:fs/promises');
  const filePath = getSessionFilePath(session.id);
  // A daemon heartbeat and a CLI update can happen concurrently. Writing to a
  // sibling temp file and renaming it keeps readers from observing truncated
  // JSON (a recurring source of corrupt session files).
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const normalized =
    session.schemaVersion === 1 ? session : { ...session, schemaVersion: 1 as const };
  try {
    const handle = await fs.open(tempPath, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

export async function saveSession(session: SessionData): Promise<void> {
  const release = await acquireFileLock(`${getSessionFilePath(session.id)}.lock`);
  try {
    await saveSessionUnlocked(session);
  } finally {
    await release();
  }
}

/** Persist a new session without overwriting an existing logical session. */
export async function createSession(session: SessionData): Promise<void> {
  await ensureSessionDir();
  const fs = await import('node:fs/promises');
  const filePath = getSessionFilePath(session.id);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const normalized =
    session.schemaVersion === 1 ? session : { ...session, schemaVersion: 1 as const };
  try {
    const handle = await fs.open(tempPath, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.link(tempPath, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Session already exists: ${session.id}. Use --resume or close it first.`);
    }
    throw error;
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

/**
 * Load a session from disk
 */
export async function loadSession(id: string): Promise<SessionData> {
  const fs = await import('node:fs/promises');
  const filePath = getSessionFilePath(id);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as SessionData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Session not found: ${id}`);
    }
    throw error;
  }
}

export async function sessionExists(id: string): Promise<boolean> {
  const fs = await import('node:fs/promises');
  try {
    await fs.access(getSessionFilePath(id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Update session's last activity and current URL
 */
export async function updateSession(
  id: string,
  updates: Partial<
    Pick<SessionData, 'currentUrl' | 'lastActivity' | 'metadata' | 'targetId' | 'transport'>
  >
): Promise<SessionData> {
  const release = await acquireFileLock(`${getSessionFilePath(id)}.lock`);
  try {
    const session = await loadSession(id);
    const mergedMetadata =
      updates.metadata !== undefined
        ? { ...session.metadata, ...updates.metadata }
        : session.metadata;
    const updated = {
      ...session,
      ...updates,
      metadata: mergedMetadata,
      lastActivity: new Date().toISOString(),
    };
    await saveSessionUnlocked(updated);
    return updated;
  } finally {
    await release();
  }
}

/** Update daemon metadata without overwriting concurrent CLI-owned fields. */
export async function updateSessionDaemon(
  id: string,
  daemon: SessionData['daemon']
): Promise<SessionData> {
  const release = await acquireFileLock(`${getSessionFilePath(id)}.lock`);
  try {
    const session = await loadSession(id);
    const updated = { ...session, daemon };
    await saveSessionUnlocked(updated);
    return updated;
  } finally {
    await release();
  }
}

/**
 * Delete a session
 */
export async function deleteSession(
  id: string,
  options: { preserveDaemonRuntime?: boolean } = {}
): Promise<void> {
  const fs = await import('node:fs/promises');
  const filePath = getSessionFilePath(id);
  const release = await acquireFileLock(`${filePath}.lock`);
  try {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    // Daemon liveness is kept in a sidecar so CLI session writes stay atomic.
    // Remove it with the logical session when a daemon has already exited.
    if (!options.preserveDaemonRuntime) {
      await fs.unlink(`${filePath}.heartbeat`).catch(() => {});
    }
  } finally {
    await release();
  }
}

/**
 * Delete a session and its log directory
 */
export async function deleteSessionFull(
  id: string,
  options: { preserveDaemonRuntime?: boolean } = {}
): Promise<void> {
  const fs = await import('node:fs/promises');

  // Delete session JSON
  const filePath = getSessionFilePath(id);
  const release = await acquireFileLock(`${filePath}.lock`);
  try {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    if (!options.preserveDaemonRuntime) {
      await fs.unlink(`${filePath}.heartbeat`).catch(() => {});
    }
  } finally {
    await release();
  }

  // Delete session log directory
  if (options.preserveDaemonRuntime) return;

  const dirPath = join(SESSION_DIR, id);
  try {
    await fs.rm(dirPath, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * List all sessions
 */
export async function listSessions(): Promise<SessionData[]> {
  await ensureSessionDir();
  const fs = await import('node:fs/promises');

  try {
    const files = await fs.readdir(SESSION_DIR);
    const sessions: SessionData[] = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const content = await fs.readFile(join(SESSION_DIR, file), 'utf-8');
          sessions.push(JSON.parse(content) as SessionData);
        } catch {
          // Skip invalid session files
        }
      }
    }

    // Sort by last activity (most recent first)
    return sessions.sort(
      (a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
    );
  } catch {
    return [];
  }
}

/**
 * Generate a unique session ID
 */
export function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}

/**
 * Get the default session (most recently used)
 */
export async function getDefaultSession(): Promise<SessionData | null> {
  const sessions = await listSessions();
  return sessions[0] ?? null;
}
