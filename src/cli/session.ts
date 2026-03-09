/**
 * Session persistence for CLI
 * Stores session data in ~/.browser-pilot/sessions/
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DaemonInfo } from '../daemon/types.ts';

export type ProviderType = 'browserbase' | 'browserless' | 'generic';

export interface SessionData {
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

export interface SessionMetadata {
  refCache?: RefCache;
  logStats?: LogStats;
  [key: string]: unknown;
}

export const SESSION_DIR = join(homedir(), '.browser-pilot', 'sessions');

/**
 * Get the file path for a session
 */
export function getSessionFilePath(id: string): string {
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
export async function saveSession(session: SessionData): Promise<void> {
  await ensureSessionDir();
  const fs = await import('node:fs/promises');
  const filePath = join(SESSION_DIR, `${session.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(session, null, 2));
}

/**
 * Load a session from disk
 */
export async function loadSession(id: string): Promise<SessionData> {
  const fs = await import('node:fs/promises');
  const filePath = join(SESSION_DIR, `${id}.json`);

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

/**
 * Update session's last activity and current URL
 */
export async function updateSession(
  id: string,
  updates: Partial<Pick<SessionData, 'currentUrl' | 'lastActivity' | 'metadata' | 'targetId'>>
): Promise<SessionData> {
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
  await saveSession(updated);
  return updated;
}

/**
 * Delete a session
 */
export async function deleteSession(id: string): Promise<void> {
  const fs = await import('node:fs/promises');
  const filePath = join(SESSION_DIR, `${id}.json`);

  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Delete a session and its log directory
 */
export async function deleteSessionFull(id: string): Promise<void> {
  const fs = await import('node:fs/promises');

  // Delete session JSON
  const filePath = join(SESSION_DIR, `${id}.json`);
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  // Delete session log directory
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
