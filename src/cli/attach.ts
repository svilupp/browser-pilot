/**
 * Shared session attach helper for CLI commands.
 *
 * Tries the daemon fast-path first (Unix socket). Explicit direct sessions use
 * a direct WebSocket; daemon sessions recover once and then fail explicitly if
 * their owner cannot be restored.
 */

import { dirname, join } from 'node:path';
import type { BatchOptions, BatchResult, Step } from '../actions/types.ts';
import type { Browser } from '../browser/browser.ts';
import type { Page } from '../browser/page.ts';
import { TargetNotFoundError } from '../browser/types.ts';
import { clearDaemonFromSession, isDaemonAlive, stopDaemon } from '../daemon/lifecycle.ts';
import {
  acquireDaemonLock,
  connectionKeyForBrowser,
  daemonIdForConnection,
  endpointFingerprint,
  readDaemonDescriptor,
  removeDaemonDescriptor,
  writeDaemonDescriptor,
} from '../daemon/registry.ts';
import { addBatchToPage, connect } from '../index.ts';
import { getEnv, isDaemonDisabledByEnv } from '../runtime/env.ts';
import { resolveCLIEndpoint } from './browser-endpoint.ts';
import { spawnDaemon, waitForDaemonReady } from './daemon-spawn.ts';
import {
  applyNetworkOverride,
  applyPermissionState,
  applyVisibilityState,
  originFromUrl,
} from './env-state.ts';
import {
  type EnvSettings,
  getDefaultSession,
  getSessionFilePath,
  loadSession,
  type SessionData,
  saveSession,
  updateSessionDaemon,
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
function hasHealthyDaemonMetadata(session: SessionData): boolean {
  if (!session.daemon) return false;

  // A daemon is long-lived by design. Heartbeat/PID are the liveness signals;
  // an arbitrary age cutoff caused healthy sessions to reconnect and prompt
  // for permission again after an hour.
  // Check PID is alive
  return isDaemonAlive(session.daemon.pid);
}

async function isDaemonHealthy(session: SessionData): Promise<boolean> {
  if (!hasHealthyDaemonMetadata(session)) return false;
  let descriptorHeartbeatPath: string | undefined;
  if (session.transport?.mode === 'daemon' && session.transport.daemonId) {
    const descriptor = await readDaemonDescriptor(session.transport.daemonId);
    if (
      !descriptor ||
      descriptor.pid !== session.daemon!.pid ||
      descriptor.socketPath !== session.daemon!.socketPath ||
      descriptor.endpointFingerprint !== endpointFingerprint(session.wsUrl)
    ) {
      return false;
    }
    descriptorHeartbeatPath = descriptor.heartbeatPath;
  }
  try {
    const heartbeatPath = session.daemon?.heartbeatPath ?? descriptorHeartbeatPath;
    if (heartbeatPath) {
      try {
        const heartbeat = await import('node:fs/promises').then((fs) =>
          fs.readFile(heartbeatPath, 'utf8')
        );
        const heartbeatAge = Date.now() - new Date(heartbeat.trim()).getTime();
        if (!Number.isFinite(heartbeatAge) || heartbeatAge > 90_000) return false;
      } catch {
        // The daemon writes its descriptor just before creating the initial
        // heartbeat sidecar; the ping below is authoritative during that gap.
      }
    }
    return await daemonIdentityMatches(session);
  } catch {
    return false;
  }
}

async function daemonIdentityMatches(session: SessionData): Promise<boolean> {
  if (!session.daemon) return false;
  let closeClient: (() => Promise<void>) | undefined;
  try {
    const { createDaemonTransport } = await import('../daemon/transport.ts');
    const { createCDPClientFromTransport } = await import('../cdp/client.ts');
    const transport = await createDaemonTransport(session.daemon.socketPath);
    const cdp = createCDPClientFromTransport(transport);
    closeClient = () => cdp.close();
    const ping = await cdp.send<{
      ok?: boolean;
      daemonId?: string;
      endpointFingerprint?: string;
    }>('daemon.ping', undefined, null);
    return (
      ping.ok === true &&
      (session.transport?.mode !== 'daemon' ||
        !session.transport.daemonId ||
        ping.daemonId === session.transport.daemonId) &&
      (ping.endpointFingerprint === undefined ||
        ping.endpointFingerprint === endpointFingerprint(session.wsUrl))
    );
  } catch {
    return false;
  } finally {
    await closeClient?.().catch(() => {});
  }
}

/**
 * Clean up a stale daemon (dead PID, expired socket, etc.)
 * Logs the fallback for centralized debugging.
 */
async function cleanupStaleDaemon(session: SessionData, reason: string): Promise<void> {
  // Log to stderr so it appears in CLI output for debugging
  console.warn(`[browser-pilot] Daemon unavailable (${reason})`);

  // Only terminate a process when the registry (v2) or the canonical
  // per-session socket path (legacy) proves that the PID is ours. A stale
  // session can contain a PID that has since been reused by an unrelated
  // process; signalling it would be unsafe.
  let metadataMatches = false;
  if (session.daemon?.pid) {
    if (session.transport?.mode === 'daemon' && session.transport.daemonId) {
      const descriptor = await readDaemonDescriptor(session.transport.daemonId);
      metadataMatches =
        descriptor?.pid === session.daemon.pid &&
        descriptor.socketPath === session.daemon.socketPath;
    } else {
      const expectedSocketPath = join(
        dirname(getSessionFilePath(session.id)),
        session.id,
        'daemon.sock'
      );
      metadataMatches = session.daemon.socketPath === expectedSocketPath;
    }
  }
  const daemonAlive = session.daemon ? isDaemonAlive(session.daemon.pid) : false;
  const identityMatches = metadataMatches && (await daemonIdentityMatches(session));
  const ownsDaemonRuntime = metadataMatches && (!daemonAlive || identityMatches);
  if (identityMatches && session.daemon?.pid) {
    await stopDaemon(session.daemon.pid).catch(() => false);
  }

  const sessionFilePath = getSessionFilePath(session.id);
  await clearDaemonFromSession(sessionFilePath, session.daemon ?? undefined);

  // A dead daemon may not have had a chance to remove its heartbeat sidecar.
  // Clear both the canonical path and any path persisted by an older daemon.
  const fsPromises = await import('node:fs/promises');
  if (ownsDaemonRuntime) {
    await fsPromises.unlink(`${sessionFilePath}.heartbeat`).catch(() => {});
  }
  if (
    ownsDaemonRuntime &&
    session.daemon?.heartbeatPath &&
    session.daemon.heartbeatPath !== `${sessionFilePath}.heartbeat`
  ) {
    await fsPromises.unlink(session.daemon.heartbeatPath).catch(() => {});
  }

  // Try to remove the socket file
  if (ownsDaemonRuntime && session.daemon?.socketPath) {
    try {
      await fsPromises.unlink(session.daemon.socketPath).catch(() => {});
    } catch {
      // Ignore
    }
  }
  if (session.transport?.mode === 'daemon' && session.transport.daemonId) {
    if (ownsDaemonRuntime) {
      await removeDaemonDescriptor(session.transport.daemonId, session.daemon?.pid);
    }
  }
}

/** Recover a daemon-owned session once, without ever downgrading it to direct mode. */
async function recoverDaemonAttachment(
  session: SessionData,
  options: { trace?: boolean },
  allowRecovery: boolean,
  reason: string
): Promise<AttachResult> {
  if (!allowRecovery) {
    throw new Error(
      `Daemon for session "${session.id}" is unavailable (${reason}). ` +
        `Daemon log: ${session.daemon?.socketPath ? join(dirname(session.daemon.socketPath), 'daemon.log') : 'unavailable'}. ` +
        'Restart the session with "bp connect".'
    );
  }

  let recoveryPid: number | undefined;
  let recovered: SessionData;
  try {
    let resolvedSession = session;
    if (session.provider === 'generic' && session.metadata?.connectionSource !== 'explicit-ws') {
      const endpoint = await resolveCLIEndpoint({
        channel:
          session.metadata?.resolvedChannel === 'custom'
            ? undefined
            : session.metadata?.resolvedChannel,
        userDataDir: session.metadata?.resolvedUserDataDir,
      });
      if (endpoint.wsUrl !== session.wsUrl) {
        resolvedSession = {
          ...session,
          wsUrl: endpoint.wsUrl,
          metadata: {
            ...session.metadata,
            connectionSource: endpoint.source,
            ...(endpoint.channel ? { resolvedChannel: endpoint.channel } : {}),
            ...(endpoint.userDataDir ? { resolvedUserDataDir: endpoint.userDataDir } : {}),
          },
        };
      }
    }

    const connectionKey = connectionKeyForBrowser({
      provider: resolvedSession.provider,
      wsUrl: resolvedSession.wsUrl,
      userDataDir: resolvedSession.metadata?.resolvedUserDataDir,
      ...(resolvedSession.metadata?.connectionSource === 'json-version'
        ? { legacyHost: new URL(resolvedSession.wsUrl).host }
        : {}),
      providerSessionId: resolvedSession.providerSessionId,
    });
    const expectedDaemonId = daemonIdForConnection(connectionKey);
    const releaseLock = await acquireDaemonLock(expectedDaemonId);
    try {
      // Another command may have recovered this browser while we waited for
      // the lock. Re-read and re-check before stopping or spawning anything.
      const fresh = await loadSession(session.id);
      const candidate: SessionData = {
        ...fresh,
        wsUrl: resolvedSession.wsUrl,
        metadata: resolvedSession.metadata,
        transport: { mode: 'daemon', daemonId: expectedDaemonId },
      };
      if (
        candidate.daemon &&
        fresh.transport?.mode === 'daemon' &&
        fresh.transport.daemonId === expectedDaemonId &&
        (await isDaemonHealthy(candidate))
      ) {
        recovered = candidate;
      } else {
        const descriptor = await readDaemonDescriptor(expectedDaemonId);
        const descriptorCandidate: SessionData | undefined = descriptor
          ? {
              ...candidate,
              daemon: {
                pid: descriptor.pid,
                socketPath: descriptor.socketPath,
                startedAt: descriptor.startedAt,
                ...(descriptor.heartbeatPath ? { heartbeatPath: descriptor.heartbeatPath } : {}),
              },
            }
          : undefined;
        if (descriptorCandidate && (await isDaemonHealthy(descriptorCandidate))) {
          await saveSession(descriptorCandidate);
          recovered = descriptorCandidate;
        } else {
          if (descriptor) {
            const descriptorAlive = isDaemonAlive(descriptor.pid);
            const descriptorIdentityMatches =
              descriptorCandidate !== undefined &&
              (await daemonIdentityMatches(descriptorCandidate));
            if (descriptorAlive && !descriptorIdentityMatches) {
              throw new Error(
                `Refusing to signal PID ${descriptor.pid}: the daemon control socket did not prove ownership`
              );
            }
            if (descriptorAlive) {
              await stopDaemon(descriptor.pid).catch(() => false);
            }
            const fsPromises = await import('node:fs/promises');
            await fsPromises.unlink(descriptor.socketPath).catch(() => {});
            if (descriptor.heartbeatPath) {
              await fsPromises.unlink(descriptor.heartbeatPath).catch(() => {});
            }
            await removeDaemonDescriptor(expectedDaemonId, descriptor.pid);
          }
          if (fresh.daemon) {
            await clearDaemonFromSession(getSessionFilePath(fresh.id), fresh.daemon);
          }

          const recoverySession: SessionData = { ...candidate, daemon: undefined };
          await saveSession(recoverySession);
          const spawned = spawnDaemon(recoverySession.id);
          recoveryPid = spawned.pid;
          const ready = await waitForDaemonReady(
            getSessionFilePath(recoverySession.id),
            spawned.pid
          );
          if (!ready) {
            await stopDaemon(spawned.pid).catch(() => false);
            throw new Error(`Daemon did not become ready within 3000ms (pid ${spawned.pid})`);
          }

          recovered = await loadSession(recoverySession.id);
          if (!recovered.daemon) throw new Error('Recovered daemon did not publish metadata');
          await writeDaemonDescriptor({
            schemaVersion: 1,
            id: expectedDaemonId,
            connectionKey,
            endpointFingerprint: endpointFingerprint(recovered.wsUrl),
            pid: recovered.daemon.pid,
            socketPath: recovered.daemon.socketPath,
            startedAt: recovered.daemon.startedAt,
            ...(recovered.daemon.heartbeatPath
              ? { heartbeatPath: recovered.daemon.heartbeatPath }
              : {}),
          });
        }
      }
    } finally {
      await releaseLock();
    }
  } catch (error) {
    if (recoveryPid) await stopDaemon(recoveryPid).catch(() => false);
    throw new Error(
      `Daemon for session "${session.id}" is unavailable (${reason}); recovery failed: ${error instanceof Error ? error.message : String(error)}. ` +
        `Daemon log: ${session.daemon?.socketPath ? join(dirname(session.daemon.socketPath), 'daemon.log') : 'unavailable'}. ` +
        'Restart the session with "bp connect".'
    );
  }
  return attachSession(recovered, options, false);
}

/**
 * Attach to a browser session.
 *
 * Daemon sessions stay on the daemon transport and get one bounded recovery
 * attempt. Only sessions explicitly persisted as direct (or legacy records
 * without a transport policy) open a direct browser WebSocket.
 */
export async function attachSession(
  session: SessionData,
  options: { trace?: boolean } = {},
  allowRecovery = true
): Promise<AttachResult> {
  const daemonDisabled = isDaemonDisabledByEnv();
  const daemonRequired = session.transport?.mode === 'daemon';

  // The environment switch controls how a session is created; it must not
  // silently rewrite an existing daemon-owned session into a direct one. This
  // preserves the one-browser-connection guarantee and makes transport
  // failures observable instead of reintroducing repeated consent prompts.
  if (daemonRequired && daemonDisabled) {
    throw new Error(
      `Session "${session.id}" requires its daemon transport, but ` +
        'BROWSER_PILOT_NO_DAEMON is enabled. Unset it or create a new session with --no-daemon.'
    );
  }

  // 1. Try daemon fast-path if daemon info is present
  if (!daemonDisabled && session.daemon) {
    if (!(await isDaemonHealthy(session))) {
      const reason = !isDaemonAlive(session.daemon.pid)
        ? 'PID not alive'
        : 'heartbeat or control socket unresponsive';
      if (daemonRequired) {
        return recoverDaemonAttachment(session, options, allowRecovery, reason);
      }
      await cleanupStaleDaemon(session, reason);
    } else {
      let closeDaemonClient: (() => Promise<void>) | undefined;
      let daemonClientIsConnected: (() => boolean) | undefined;
      try {
        const { createDaemonTransport } = await import('../daemon/transport.ts');
        const { createCDPClientFromTransport } = await import('../cdp/client.ts');

        const transport = await createDaemonTransport(session.daemon.socketPath);
        const cdp = createCDPClientFromTransport(transport, {
          debug: options.trace,
        });
        closeDaemonClient = () => cdp.close();
        daemonClientIsConnected = () => cdp.isConnected;

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

        // `bp connect` starts the daemon before a target is selected, so the
        // daemon cannot know the flat CDP session id until this first attach.
        // Persist it per logical session so subsequent commands can pin their
        // Page directly instead of re-attaching the target on every command.
        const activeCdpSessionId = page.cdpClient.sessionId;
        let attachedSession = session;
        if (
          activeCdpSessionId &&
          session.daemon &&
          session.daemon.cdpSessionId !== activeCdpSessionId
        ) {
          const updatedDaemon = { ...session.daemon, cdpSessionId: activeCdpSessionId };
          attachedSession = await updateSessionDaemon(session.id, updatedDaemon);
        }

        return { session: attachedSession, browser, page, viaDaemon: true };
      } catch (err) {
        if (err instanceof TargetNotFoundError || daemonClientIsConnected?.()) {
          // A healthy control socket plus a page/session error is not evidence
          // that the browser owner died. Restarting here can repeat Chrome's
          // permission prompt and can replay unrelated initialization work.
          await closeDaemonClient?.().catch(() => {});
          throw err;
        }
        const reason = err instanceof Error ? err.message : String(err);
        if (daemonRequired) {
          return recoverDaemonAttachment(session, options, allowRecovery, reason);
        }
        await cleanupStaleDaemon(session, reason);
        // Legacy sessions without an explicit transport policy retain the
        // historical direct reconnect behavior.
      }
    }
  }

  if (daemonRequired && !daemonDisabled && !session.daemon) {
    return recoverDaemonAttachment(session, options, allowRecovery, 'no daemon metadata');
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
    // Keep the logical record recoverable. A transient browser outage should
    // not silently destroy the user's session and persisted environment.
    throw new Error(
      `Session "${session.id}" is no longer valid (browser may have closed).\n` +
        'Session file was preserved. Restart the browser or run "bp clean" to remove it.'
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

/** Canonical connection entry point for stored CLI sessions. */
export const openSession = attachSession;
