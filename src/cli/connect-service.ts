/**
 * Shared local-browser session bootstrap for commands that auto-connect.
 *
 * Keeping this path alongside `bp connect` is important: an auto-connect
 * command must not create a short-lived direct WebSocket when daemon mode is
 * enabled, otherwise it reintroduces repeated Chrome permission prompts.
 */

import { isDaemonAlive, stopDaemon } from '../daemon/lifecycle.ts';
import {
  acquireDaemonLock,
  connectionKeyForBrowser,
  daemonIdForConnection,
  endpointFingerprint,
  findHealthyDaemon,
  writeDaemonDescriptor,
} from '../daemon/registry.ts';
import { type BrowserOptions, connect, type Page } from '../index.ts';
import type { ResolvedBrowserSource } from '../providers/local-discovery.ts';
import { isDaemonDisabledByEnv } from '../runtime/env.ts';
import { attachSession } from './attach.ts';
import { spawnDaemon, waitForDaemonReady } from './daemon-spawn.ts';
import {
  createSession,
  deleteSession,
  generateSessionId,
  getSessionFilePath,
  loadSession,
  type ProviderType,
  type SessionData,
  saveSession,
  sessionExists,
} from './session.ts';

export interface AutoSessionResult {
  browser: Awaited<ReturnType<typeof connect>>;
  page: Page;
  session: SessionData;
  isNewSession: true;
}

export interface CreateLocalSessionOptions {
  wsUrl: string;
  trace?: boolean;
  name?: string;
  noDaemon?: boolean;
  newTab?: boolean;
  pageUrl?: string;
  targetUrl?: string;
  foreground?: boolean;
  daemonIdleMins?: number;
  connectionSource?: ResolvedBrowserSource;
  resolvedChannel?: BrowserOptions['channel'] | 'custom';
  resolvedUserDataDir?: string;
  metadata?: SessionData['metadata'];
}

function daemonInfoFromDescriptor(descriptor: {
  pid: number;
  socketPath: string;
  startedAt: string;
  heartbeatPath?: string;
}): NonNullable<SessionData['daemon']> {
  return {
    pid: descriptor.pid,
    socketPath: descriptor.socketPath,
    startedAt: descriptor.startedAt,
    ...(descriptor.heartbeatPath ? { heartbeatPath: descriptor.heartbeatPath } : {}),
  };
}

/** Create and persist a local session, using the browser-scoped daemon by default. */
export async function createLocalSession(
  options: CreateLocalSessionOptions
): Promise<AutoSessionResult> {
  const daemonDisabled = isDaemonDisabledByEnv();
  const useDaemon = !options.noDaemon && !daemonDisabled;
  const sessionId = options.name ?? generateSessionId();
  if (await sessionExists(sessionId)) {
    throw new Error(`Session already exists: ${sessionId}. Use --resume or close it first.`);
  }
  const now = new Date().toISOString();
  const connectionKey = connectionKeyForBrowser({
    provider: 'generic',
    wsUrl: options.wsUrl,
    userDataDir: options.resolvedUserDataDir,
    ...(options.connectionSource === 'json-version'
      ? { legacyHost: new URL(options.wsUrl).host }
      : {}),
  });
  const daemonId = daemonIdForConnection(connectionKey);
  const metadata: SessionData['metadata'] = {
    ...(options.connectionSource ? { connectionSource: options.connectionSource } : {}),
    ...(options.resolvedChannel ? { resolvedChannel: options.resolvedChannel } : {}),
    ...(options.resolvedUserDataDir ? { resolvedUserDataDir: options.resolvedUserDataDir } : {}),
  };

  if (!useDaemon) {
    const browser = await connect({
      provider: 'generic' as ProviderType,
      wsUrl: options.wsUrl,
      debug: options.trace,
    });
    try {
      const page = options.newTab
        ? await browser.newPage(options.pageUrl ?? 'about:blank', {
            background: options.foreground !== true,
          })
        : await browser.page(
            undefined,
            options.targetUrl !== undefined ? { targetUrl: options.targetUrl } : undefined
          );
      const currentUrl = await page.url();
      const session: SessionData = {
        id: sessionId,
        provider: 'generic',
        wsUrl: browser.wsUrl,
        createdAt: now,
        lastActivity: now,
        currentUrl,
        targetId: page.targetId,
        transport: {
          mode: 'direct',
          reason: options.noDaemon ? 'flag' : 'environment',
        },
        metadata: { ...browser.metadata, ...metadata, ...options.metadata },
      };
      await createSession(session);
      return { browser, page, session, isNewSession: true };
    } catch (error) {
      await browser.disconnect().catch(() => {});
      throw error;
    }
  }

  const provisional: SessionData = {
    id: sessionId,
    provider: 'generic',
    wsUrl: options.wsUrl,
    createdAt: now,
    lastActivity: now,
    currentUrl: 'about:blank',
    transport: { mode: 'daemon', daemonId },
    metadata,
  };
  await createSession(provisional);

  let daemonSpawned = false;
  let spawnedDaemonPid: number | undefined;
  let browser: AutoSessionResult['browser'] | undefined;
  try {
    let daemonSession: SessionData;
    const releaseLock = await acquireDaemonLock(daemonId);
    try {
      const existingDaemon = await findHealthyDaemon(connectionKey);
      if (existingDaemon) {
        daemonSession = {
          ...provisional,
          daemon: daemonInfoFromDescriptor(existingDaemon),
        };
        await saveSession(daemonSession);
      } else {
        const idleTimeoutMs = options.daemonIdleMins
          ? options.daemonIdleMins * 60 * 1000
          : undefined;
        const spawned = spawnDaemon(sessionId, idleTimeoutMs);
        daemonSpawned = true;
        spawnedDaemonPid = spawned.pid;
        const ready = await waitForDaemonReady(getSessionFilePath(sessionId), spawned.pid);
        if (!ready) {
          throw new Error(`Daemon did not become ready within 3000ms (pid ${spawned.pid})`);
        }
        daemonSession = await loadSession(sessionId);
        if (!daemonSession.daemon) {
          throw new Error('Daemon reported ready without daemon metadata');
        }
        await writeDaemonDescriptor({
          schemaVersion: 1,
          id: daemonId,
          connectionKey,
          endpointFingerprint: endpointFingerprint(options.wsUrl),
          pid: daemonSession.daemon.pid,
          socketPath: daemonSession.daemon.socketPath,
          startedAt: daemonSession.daemon.startedAt,
          ...(daemonSession.daemon.heartbeatPath
            ? { heartbeatPath: daemonSession.daemon.heartbeatPath }
            : {}),
        });
      }
    } finally {
      await releaseLock();
    }

    const attached = await attachSession(daemonSession, { trace: options.trace });
    browser = attached.browser;
    let page = attached.page;
    if (options.newTab) {
      page = await browser.newPage(options.pageUrl ?? 'about:blank', {
        background: options.foreground !== true,
      });
    } else if (
      options.targetUrl !== undefined &&
      !(await attached.page.url()).includes(options.targetUrl)
    ) {
      // attachSession must materialize one Page to return the daemon-backed
      // Browser. Use a distinct cache key when the requested target differs;
      // Browser.page intentionally rejects retargeting an existing cache key.
      page = await browser.page('selected', { targetUrl: options.targetUrl });
    }

    const attachedCdpSessionId = attached.session.daemon?.cdpSessionId;
    const selectedCdpSessionId = page.cdpClient.sessionId;
    if (
      attachedCdpSessionId &&
      selectedCdpSessionId &&
      attachedCdpSessionId !== selectedCdpSessionId
    ) {
      // The bootstrap Page was only needed to establish the Browser wrapper.
      // Do not leak its target attachment when --new-tab or --target-url
      // selects another target on the same persistent daemon connection.
      await page.cdpClient
        .send('daemon.detach', { sessionId: attachedCdpSessionId }, null)
        .catch(() => {});
    }
    const currentUrl = await page.url();
    const finalDaemon = attached.session.daemon
      ? {
          ...attached.session.daemon,
          ...(selectedCdpSessionId ? { cdpSessionId: selectedCdpSessionId } : {}),
        }
      : daemonSession.daemon;
    const finalSession: SessionData = {
      ...provisional,
      wsUrl: browser.wsUrl,
      targetId: page.targetId,
      currentUrl,
      daemon: finalDaemon,
      metadata: { ...browser.metadata, ...metadata, ...options.metadata },
    };
    await saveSession(finalSession);
    return { browser, page, session: finalSession, isNewSession: true };
  } catch (error) {
    await browser?.disconnect().catch(() => {});
    if (daemonSpawned) {
      const pid = spawnedDaemonPid;
      if (pid && isDaemonAlive(pid)) await stopDaemon(pid).catch(() => false);
    }
    await deleteSession(sessionId).catch(() => {});
    throw new Error(
      `Could not create local browser session: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
