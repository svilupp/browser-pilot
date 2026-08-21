/**
 * Shared session attach helper for CLI commands.
 *
 * Tries the daemon fast-path first (Unix socket), then falls back
 * to direct WebSocket connection (the original behavior).
 * If the daemon is stale or unresponsive, cleans up and falls back silently.
 */

import type { BatchOptions, BatchResult, Step } from '../actions/types.ts';
import type { Browser } from '../browser/browser.ts';
import type { Page } from '../browser/page.ts';
import { TargetNotFoundError } from '../browser/types.ts';
import { clearDaemonFromSession, isDaemonAlive } from '../daemon/lifecycle.ts';
import { DAEMON_MAX_AGE_MS } from '../daemon/types.ts';
import { addBatchToPage, connect } from '../index.ts';
import { getEnv } from '../runtime/env.ts';
import {
  applyNetworkOverride,
  applyPermissionState,
  applyVisibilityState,
  originFromUrl,
} from './env-state.ts';
import {
  deleteSession,
  type EnvSettings,
  getDefaultSession,
  getSessionFilePath,
  loadSession,
  type SessionData,
} from './session.ts';

export interface AttachResult {
  session: SessionData;
  browser: Browser;
  page: Page & { batch: (steps: Step[], options?: BatchOptions) => Promise<BatchResult> };
  /** Whether this attachment used the daemon fast-path */
  viaDaemon: boolean;
}

async function applySessionEnvironment(
  page: Page,
  currentUrl: string,
  settings: EnvSettings | undefined
): Promise<void> {
  if (!settings) {
    return;
  }

  const origin = originFromUrl(currentUrl);

  if (Array.isArray(settings.permissions)) {
    await applyPermissionState(page.cdpClient, origin, settings.permissions);
  }

  if (settings.geolocation) {
    await page.setGeolocation(settings.geolocation);
  }

  if (settings.visibility) {
    await applyVisibilityState(page.cdpClient, settings.visibility);
  }

  if (settings.network) {
    await applyNetworkOverride(page.cdpClient, settings.network);
  }

  if (settings.auth?.extraHeaders) {
    const { fromEnv, values } = settings.auth.extraHeaders;
    const headers: Record<string, string> = { ...values };
    if (fromEnv) {
      for (const [headerName, envVarName] of Object.entries(fromEnv)) {
        const resolved = getEnv(envVarName);
        if (resolved !== undefined) {
          headers[headerName] = resolved;
        }
      }
    }
    if (Object.keys(headers).length > 0) {
      await page.setExtraHTTPHeaders(headers);
    }
  }

  if (settings.auth?.cookies) {
    for (const cookie of settings.auth.cookies) {
      const { valueFromEnv, ...rest } = cookie;
      const value = valueFromEnv !== undefined ? getEnv(valueFromEnv) : rest.value;
      if (value === undefined) {
        continue;
      }
      await page.setCookie({ ...rest, value });
    }
  }
}

/**
 * Resolve the session to use (explicit ID or most recent).
 */
export async function resolveSession(sessionId?: string): Promise<SessionData> {
  if (sessionId) {
    return loadSession(sessionId);
  }
  const session = await getDefaultSession();
  if (!session) {
    throw new Error('No session found. Run "bp connect" first.');
  }
  return session;
}

/**
 * Check if a daemon is healthy: PID alive + socket not expired.
 */
function isDaemonHealthy(session: SessionData): boolean {
  if (!session.daemon) return false;

  // Check max age (60 minutes)
  const daemonAge = Date.now() - new Date(session.daemon.startedAt).getTime();
  if (daemonAge > DAEMON_MAX_AGE_MS) {
    return false;
  }

  // Check heartbeat staleness (if heartbeat exists, it shouldn't be older than 3x interval)
  if (session.daemon.lastHeartbeat) {
    const heartbeatAge = Date.now() - new Date(session.daemon.lastHeartbeat).getTime();
    if (heartbeatAge > 90_000) {
      return false;
    }
  }

  // Check PID is alive
  return isDaemonAlive(session.daemon.pid);
}

/**
 * Clean up a stale daemon (dead PID, expired socket, etc.)
 * Logs the fallback for centralized debugging.
 */
async function cleanupStaleDaemon(session: SessionData, reason: string): Promise<void> {
  // Log to stderr so it appears in CLI output for debugging
  console.warn(`[browser-pilot] Daemon unavailable (${reason}), falling back to direct WebSocket`);

  const sessionFilePath = getSessionFilePath(session.id);
  await clearDaemonFromSession(sessionFilePath);

  // Try to remove the socket file
  if (session.daemon?.socketPath) {
    try {
      const fsPromises = await import('node:fs/promises');
      await fsPromises.unlink(session.daemon.socketPath).catch(() => {});
    } catch {
      // Ignore
    }
  }
}

/**
 * Attach to a browser session.
 *
 * Tries daemon fast-path first (if daemon info present and healthy),
 * then falls back to direct WebSocket connection.
 * On failure, cleans up the stale session file.
 */
export async function attachSession(
  session: SessionData,
  options: { trace?: boolean } = {}
): Promise<AttachResult> {
  // 1. Try daemon fast-path if daemon info is present
  if (session.daemon) {
    if (!isDaemonHealthy(session)) {
      const reason = !isDaemonAlive(session.daemon.pid)
        ? 'PID not alive'
        : 'daemon expired (>60min)';
      await cleanupStaleDaemon(session, reason);
    } else {
      let closeDaemonClient: (() => Promise<void>) | undefined;
      try {
        const { createDaemonTransport } = await import('../daemon/transport.ts');
        const { createCDPClientFromTransport } = await import('../cdp/client.ts');

        const transport = await createDaemonTransport(session.daemon.socketPath);
        const cdp = createCDPClientFromTransport(transport, {
          debug: options.trace,
        });
        closeDaemonClient = () => cdp.close();

        const { Browser: BrowserClass } = await import('../browser/browser.ts');
        const { Page: PageClass } = await import('../browser/page.ts');
        const { createSessionScopedCDP } = await import('../cdp/session-scope.ts');
        const browser = BrowserClass.fromCDP(cdp, session);
        if (session.targetId) {
          const { targetInfos } = await cdp.send<{
            targetInfos: Array<{ type: string; targetId: string; url: string; title?: string }>;
          }>('Target.getTargets', undefined, null);
          const pageTargets = targetInfos.filter((target) => target.type === 'page');
          if (!pageTargets.some((target) => target.targetId === session.targetId)) {
            throw new TargetNotFoundError({
              targetId: session.targetId,
              availableTargets: pageTargets,
              reason: 'The persisted session target is no longer attached.',
            });
          }
        }
        const page =
          session.daemon.cdpSessionId && session.targetId
            ? addBatchToPage(
                await (async () => {
                  const cdpSessionId = session.daemon?.cdpSessionId as string;
                  // Keep the raw client's default session in sync for any code
                  // that reads it, but pin the Page to a scoped view so its
                  // session-omitting sends/events stay on ITS target even if
                  // another target is later attached on the shared client.
                  cdp.setSessionId(cdpSessionId);
                  const scoped = createSessionScopedCDP(cdp, cdpSessionId);
                  const attachedPage = new PageClass(scoped, session.targetId!);
                  await attachedPage.init();
                  return attachedPage;
                })()
              )
            : addBatchToPage(await browser.page(undefined, { targetId: session.targetId }));

        // Hydrate ref map from session cache if URL matches
        const currentUrl = await page.url();
        await applySessionEnvironment(page, currentUrl, session.metadata?.env);
        const refCache = session.metadata?.refCache;
        if (refCache && refCache.url === currentUrl) {
          page.importRefMap(refCache.refMap);
        }

        return { session, browser, page, viaDaemon: true };
      } catch (err) {
        if (err instanceof TargetNotFoundError) {
          // Target selection failures are deterministic, not stale-daemon
          // evidence. Preserve the healthy daemon/session metadata and close
          // only this client connection before surfacing the error.
          await closeDaemonClient?.();
          throw err;
        }
        const reason = err instanceof Error ? err.message : String(err);
        await cleanupStaleDaemon(session, reason);
        // Fall through to direct WebSocket
      }
    }
  }

  // 2. Fallback: direct WebSocket connection (original behavior)
  let browser: Browser;
  try {
    browser = await connect({
      provider: session.provider,
      wsUrl: session.wsUrl,
      debug: options.trace,
    });
  } catch {
    // Connection failed — browser is probably gone. Clean up stale session.
    await deleteSession(session.id);
    throw new Error(
      `Session "${session.id}" is no longer valid (browser may have closed).\n` +
        'Session file has been cleaned up. Run "bp connect" to create a new session.'
    );
  }

  const page = addBatchToPage(await browser.page(undefined, { targetId: session.targetId }));

  // Hydrate ref map from session cache if URL matches
  const currentUrl = await page.url();
  await applySessionEnvironment(page, currentUrl, session.metadata?.env);
  const refCache = session.metadata?.refCache;
  if (refCache && refCache.url === currentUrl) {
    page.importRefMap(refCache.refMap);
  }

  return { session, browser, page, viaDaemon: false };
}
