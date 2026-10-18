/**
 * Daemon Unix socket server
 *
 * Accepts connections from CLI clients on a Unix domain socket.
 * Each client gets CDP events forwarded in real-time and can send
 * CDP commands that are proxied to Chrome via the persistent WebSocket.
 */

import { chmodSync } from 'node:fs';
import { lstat, unlink } from 'node:fs/promises';
import { createServer, connect as netConnect, type Server, type Socket } from 'node:net';
import type { CDPClient } from '../cdp/client.ts';
import { CDPError, type CDPErrorData } from '../cdp/protocol.ts';
import { RuntimeResultError } from '../cdp/runtime-result.ts';
import type { OwnerActionService } from '../core/owner-actions/index.ts';
import { OwnerCleanupQueue } from '../owner/cleanup-queue.ts';
import { HandbackCoordinator } from '../owner/handback.ts';
import {
  LeaseController,
  type OwnerAdmission,
  OwnerLeaseError,
} from '../owner/lease-controller.ts';
import { PassiveEvents } from '../owner/passive-events.ts';
import { daemonLog } from './lifecycle.ts';
import { OwnerJournal } from './owner-journal.ts';
import type { DaemonEvent, DaemonRequest, DaemonResponse } from './types.ts';

/**
 * Line-buffered reader for newline-delimited JSON over a socket.
 */
function createLineReader(socket: Socket, onLine: (line: string) => void): void {
  let buffer = '';
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line.length > 0) {
        onLine(line);
      }
      newlineIdx = buffer.indexOf('\n');
    }
  });
}

/**
 * Write a JSON message followed by newline to a socket.
 */
function writeMessage(socket: Socket, msg: DaemonResponse | DaemonEvent): void {
  if (!socket.writable) return;
  try {
    socket.write(`${JSON.stringify(msg)}\n`);
  } catch {
    // Socket may have closed between the check and write
  }
}

function isValidDaemonRequest(value: unknown): value is DaemonRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<DaemonRequest>;
  return (
    typeof request.id === 'number' &&
    Number.isInteger(request.id) &&
    typeof request.method === 'string' &&
    request.method.length > 0 &&
    (request.ipcBudget === undefined ||
      (typeof request.ipcBudget === 'object' &&
        request.ipcBudget !== null &&
        Number.isFinite(request.ipcBudget.timeoutMs) &&
        request.ipcBudget.timeoutMs > 0 &&
        Number.isFinite(request.ipcBudget.sentAt)))
  );
}

function serializeError(error: unknown): CDPErrorData {
  if (error instanceof OwnerLeaseError) return { code: error.code, message: error.message };
  if (error instanceof CDPError) {
    return {
      code: error.code,
      message: error.message,
      data: error.data,
    };
  }

  if (error instanceof Error) {
    return {
      code: -32000,
      message: error.message,
    };
  }

  return {
    code: -32000,
    message: String(error),
  };
}

export interface DaemonServer {
  /** Underlying net.Server */
  server: Server;
  /** Number of currently connected clients */
  clientCount: number;
  readonly commandLeaseActive: boolean;
  /** Close the server and all client connections */
  close(): Promise<void>;
}

export interface DaemonIdentity {
  /** Connection-scoped leases are required for owner-held hosted sessions. */
  requireLease?: boolean;
  daemonId?: string;
  endpointFingerprint?: string;
  handback?: (
    session: string,
    targetId: string,
    currentUrl: string,
    ownerEpoch: string,
    expectedRevision?: number
  ) => Promise<number>;
  resolveBinding?: (session: string) => Promise<number>;
  /** Trusted owner configuration only; callers cannot install or relax this policy. */
  ownerActions?: OwnerActionService;
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  const active = await new Promise<boolean>((resolve) => {
    const socket = netConnect(socketPath);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, 200);
    socket.once('connect', () => {
      finish(true);
    });
    // Keep the listener installed until destroy completes. Bun may report a
    // second socket error while an unsuccessful Unix-socket connect unwinds.
    socket.on('error', () => {
      finish(false);
    });
  });
  if (active) throw new Error(`Daemon socket is already active: ${socketPath}`);
  await unlink(socketPath).catch(() => {});
}

/**
 * Start the daemon Unix socket server.
 *
 * @param socketPath - Path to the Unix domain socket file
 * @param cdp - The persistent CDP client connected to Chrome
 * @param onActivity - Called whenever a client sends a command (for idle timeout reset)
 */
export async function startDaemonServer(
  socketPath: string,
  cdp: CDPClient,
  onActivity: () => void,
  onShutdown?: (reason?: 'recovery') => void,
  identity?: DaemonIdentity
): Promise<DaemonServer> {
  // Never unlink a live server's socket. A concurrent or manually started
  // daemon must fail closed instead of stealing the existing socket path.
  await removeStaleSocket(socketPath);

  const clients = new Set<Socket>();
  const owner = new LeaseController();
  const passive = new PassiveEvents((client, sessionId, reason) =>
    writeMessage(client as Socket, {
      method: 'daemon.subscriptionRevoked',
      params: { sessionId, reason },
    })
  );
  let shuttingDown = false;
  const journal = identity?.requireLease
    ? new OwnerJournal(`${socketPath}.owner-pending`)
    : undefined;
  const leasedSessions = new WeakMap<Socket, string>();
  const grants = new WeakMap<Socket, string>();
  const cleanup = new OwnerCleanupQueue(async (sessionId) => {
    await cdp.send('Target.detachFromTarget', { sessionId }, null);
    passive.detach(sessionId);
  });
  const cleanupIdle = (socket: Socket) => {
    cleanup.drainObservers(!owner.active);
    const grant = grants.get(socket);
    if (!grant || owner.active) return;
    cleanup.leaseEnded(grant, async () => {
      if (identity?.ownerActions)
        await identity.ownerActions.revoke(grant, (method, params, sessionId) =>
          cdp.send(method, params, sessionId)
        );
      journal?.clear();
    });
  };
  const bindingRevisions = new WeakMap<Socket, number>();
  const operations = new Map<string, OwnerAdmission>();
  const handbacks = new HandbackCoordinator();

  // Forward all CDP events to all connected clients. The sessionId is carried
  // through so the CLI's CDP client can route session-scoped events (OOPIF child
  // sessions) correctly instead of leaking them into main-page handlers.
  const forwardEvent = (method: string, params: Record<string, unknown>, sessionId?: string) => {
    if (method === 'Target.detachedFromTarget' && typeof params['sessionId'] === 'string')
      passive.detach(params['sessionId']);
    if (identity?.ownerActions && !identity.ownerActions.rawAllowed) return;
    const event: DaemonEvent = { method, params, sessionId };
    for (const client of clients) {
      if (
        !identity?.requireLease ||
        owner.owns(client) ||
        passive.permits(client, method, sessionId)
      )
        writeMessage(client, event);
    }
  };
  cdp.onAny(forwardEvent);

  // Safety net for paused auto-attached children. Page.init() arms
  // `Target.setAutoAttach { waitForDebuggerOnStart: true }` on this long-lived
  // connection, so iframes/workers attach PAUSED. The CLI process normally
  // unpauses them via `Target.runIfWaitingForDebugger`, but if no client is
  // connected (the CLI already exited) a newly attached child would freeze the
  // user's live tab indefinitely. Calling runIfWaitingForDebugger is always safe
  // to do redundantly, so we unpause children the CLI isn't around to handle.
  const FALLBACK_UNPAUSE_MS = 2000;
  const fallbackTimers = new Set<ReturnType<typeof setTimeout>>();
  const unpauseSession = (sessionId: string) => {
    cdp.runIfWaitingForDebugger(sessionId).catch((err: unknown) => {
      daemonLog('warn', `Failed to unpause session ${sessionId}: ${String(err)}`);
    });
  };
  const unsubscribeAttached = cdp.onTargetAttached((info) => {
    if (!info.waitingForDebugger) return;
    const { sessionId } = info;
    if (clients.size === 0) {
      daemonLog('info', `No client connected; unpausing waiting target ${sessionId}`);
      unpauseSession(sessionId);
      return;
    }
    // A client is connected and should unpause the child itself. Fall back after
    // a short grace delay in case it exits or fails to handle it. The timer is
    // tracked so a shutdown mid-grace-period doesn't leave it firing post-close.
    const timer = setTimeout(() => {
      fallbackTimers.delete(timer);
      if (cdp.hasSession(sessionId)) {
        daemonLog('info', `Fallback unpausing still-attached target ${sessionId}`);
        unpauseSession(sessionId);
      }
    }, FALLBACK_UNPAUSE_MS);
    fallbackTimers.add(timer);
  });

  const server = createServer((socket: Socket) => {
    clients.add(socket);
    daemonLog('info', `Client connected (total: ${clients.size})`);

    const handleRequestLine = async (line: string): Promise<void> => {
      onActivity();

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        writeMessage(socket, {
          id: -1,
          error: { code: -32700, message: 'Invalid JSON' },
        });
        return;
      }

      if (!isValidDaemonRequest(parsed)) {
        writeMessage(socket, {
          id: -1,
          error: { code: -32600, message: 'Invalid request shape' },
        });
        return;
      }

      const request = parsed;

      try {
        const remaining = request.ipcBudget
          ? Math.min(
              request.ipcBudget.timeoutMs,
              request.ipcBudget.sentAt + request.ipcBudget.timeoutMs - Date.now()
            )
          : undefined;
        if (remaining !== undefined && remaining <= 0)
          throw new Error('IPC deadline exceeded before browser dispatch');
        const sendOptions = remaining === undefined ? undefined : { timeout: remaining };
        const sendToBrowser = async (
          method: string,
          params?: Record<string, unknown>,
          sessionId?: string | null
        ): Promise<unknown> => {
          if (identity?.ownerActions && !identity.ownerActions.rawAllowed)
            throw new OwnerLeaseError(
              'owner_policy: raw CDP is unavailable under the strict action profile'
            );
          let admission: OwnerAdmission | undefined;
          if (identity?.requireLease)
            admission = owner.admit(
              socket,
              request.ownerFence,
              request.ownerOperationId ? operations.get(request.ownerOperationId) : undefined
            );
          try {
            if (admission) owner.assertCurrent(admission);
            const result: unknown = await cdp.send(method, params, sessionId, sendOptions);
            if (method === 'Target.attachToTarget' && result && typeof result === 'object') {
              const id = (result as { sessionId?: unknown }).sessionId;
              if (typeof id === 'string') passive.attach(socket, id);
            }
            if (method === 'Target.detachFromTarget' && typeof params?.['sessionId'] === 'string')
              passive.detach(params['sessionId']);
            return result;
          } catch (error) {
            if (admission) {
              const state = (error as { dispatchState?: string }).dispatchState;
              const uncertain = state !== 'not_dispatched' && !(error instanceof CDPError);
              owner.finish(admission, uncertain);
              if (uncertain) passive.revoke(socket, 'owner_uncertain');
              admission = undefined;
            }
            throw error;
          } finally {
            if (admission) owner.finish(admission);
            cleanupIdle(socket);
          }
        };
        // Control-plane methods never cross the browser connection. They let
        // clients verify daemon ownership without opening another CDP socket.
        let result: unknown;
        if (request.method.startsWith('owner.action.')) {
          if (!identity?.ownerActions) throw new Error('Owner action profile unavailable');
          const admission = owner.admit(socket, request.ownerFence);
          let uncertain = false;
          try {
            result = await identity.ownerActions.dispatch(request.method, request.params ?? {}, {
              grant: admission.fence,
              assertCurrent: () => owner.assertCurrent(admission),
              send: async (method, params, sessionId) => {
                owner.assertCurrent(admission);
                const budget = request.ipcBudget;
                const timeout = budget
                  ? Math.min(budget.timeoutMs, budget.sentAt + budget.timeoutMs - Date.now())
                  : undefined;
                if (timeout !== undefined && timeout <= 0)
                  throw Object.assign(
                    new Error('IPC deadline exceeded before owner action dispatch'),
                    { dispatchState: 'not_dispatched' }
                  );
                return await cdp.send(
                  method,
                  params,
                  sessionId,
                  timeout === undefined ? undefined : { timeout }
                );
              },
            });
            const state = (result as { dispatchState?: string } | undefined)?.dispatchState;
            uncertain = state === 'unknown' || state === 'uncertain';
          } catch (error) {
            const state = (error as { dispatchState?: string }).dispatchState;
            uncertain = state === 'unknown' || state === 'uncertain';
            throw error;
          } finally {
            owner.finish(admission, uncertain);
            if (uncertain) passive.revoke(socket, 'owner_uncertain');
          }
        } else if (request.method === 'daemon.acquireLease') {
          cleanup.drainObservers(!owner.active);
          await cleanup.ready();
          if (shuttingDown) throw new OwnerLeaseError('session_busy: owner is shutting down');
          if (journal?.unfinished)
            throw new OwnerLeaseError(
              'session_busy: unfinished prior owner requires reconciliation'
            );
          const wasActive = owner.active;
          const grant = owner.acquire(socket);
          grants.set(socket, grant.grantId);
          if (!wasActive) {
            try {
              journal?.claim(grant.ownerEpoch, grant.grantId);
            } catch (error) {
              owner.release(socket);
              throw error;
            }
            handbacks.clear(socket);
          }
          const logicalSession = request.params?.['session'];
          if (typeof logicalSession === 'string' && logicalSession !== leasedSessions.get(socket))
            passive.revoke(socket);
          if (typeof logicalSession === 'string' && !wasActive) {
            try {
              if (identity?.resolveBinding)
                bindingRevisions.set(socket, await identity.resolveBinding(logicalSession));
              leasedSessions.set(socket, logicalSession);
            } catch (error) {
              owner.release(socket);
              journal?.clear();
              throw error;
            }
          }
          result = {
            ok: true,
            protocolVersion: 2,
            rawCompatibility: identity?.ownerActions?.rawAllowed ?? true,
            ...grant,
          };
        } else if (request.method === 'daemon.attachObserver') {
          if (identity?.ownerActions && !identity.ownerActions.rawAllowed)
            throw new OwnerLeaseError(
              'owner_policy: raw CDP is unavailable under the strict action profile'
            );
          const targetId = request.params?.['targetId'];
          if (typeof targetId !== 'string' || !targetId)
            throw new Error('Exact observer target required');
          const admission = owner.admit(socket, request.ownerFence);
          let uncertain = false;
          try {
            owner.assertCurrent(admission);
            const attached = await cdp.send<{ sessionId?: unknown }>(
              'Target.attachToTarget',
              { targetId, flatten: true },
              null,
              sendOptions
            );
            if (typeof attached.sessionId !== 'string') {
              uncertain = true;
              throw new Error('Observer attachment unavailable');
            }
            passive.observeAttachment(socket, attached.sessionId);
            if (socket.destroyed || !clients.has(socket)) {
              cleanup.queueObservers(passive.takeCleanup(socket));
              passive.disconnect(socket);
            } else owner.assertCurrent(admission);
            result = { sessionId: attached.sessionId };
          } catch (error) {
            const state = (error as { dispatchState?: string }).dispatchState;
            uncertain ||= state !== 'not_dispatched' && !(error instanceof CDPError);
            throw error;
          } finally {
            owner.finish(admission, uncertain);
            cleanupIdle(socket);
          }
        } else if (request.method === 'daemon.subscribeEvents') {
          if (identity?.ownerActions && !identity.ownerActions.rawAllowed)
            throw new OwnerLeaseError('owner_policy: passive raw telemetry is unavailable');
          const admission = owner.admit(socket, request.ownerFence);
          try {
            const sessionId = request.params?.['sessionId'];
            const logicalSession = leasedSessions.get(socket);
            if (typeof sessionId !== 'string' || !logicalSession)
              throw new Error('Exact named passive session required');
            passive.subscribe(socket, sessionId, logicalSession);
            result = { ok: true, sessionId };
          } finally {
            owner.finish(admission);
          }
        } else if (request.method === 'daemon.unsubscribeEvents') {
          passive.revoke(socket);
          result = { ok: true };
        } else if (request.method === 'daemon.beginOperation') {
          const admission = owner.admit(socket, request.ownerFence);
          const operationId = crypto.randomUUID();
          operations.set(operationId, admission);
          result = { operationId };
        } else if (request.method === 'daemon.endOperation') {
          owner.validateControl(socket, request.ownerFence);
          const id = request.params?.['operationId'];
          const admission = typeof id === 'string' ? operations.get(id) : undefined;
          if (!admission || admission.client !== socket) throw new Error('Unknown owner operation');
          operations.delete(id as string);
          owner.finish(admission, request.params?.['uncertain'] === true);
          if (request.params?.['uncertain'] === true) passive.revoke(socket, 'owner_uncertain');
          result = { ok: true };
        } else if (request.method === 'daemon.releaseLease') {
          owner.validateControl(socket, request.ownerFence);
          const grantId = request.ownerFence?.grantId;
          await owner.freeze(socket);
          const transaction = owner.holdFrozen(socket);
          let uncertain = true;
          try {
            if (grantId && identity?.ownerActions)
              await identity.ownerActions.revoke(grantId, (method, params, sessionId) =>
                cdp.send(method, params, sessionId)
              );
            uncertain = false;
          } finally {
            owner.finish(transaction, uncertain);
          }
          owner.release(socket);
          cleanup.drainObservers(true);
          if (grantId) cleanup.markComplete(grantId);
          journal?.clear();
          result = { ok: true };
        } else if (request.method === 'daemon.handback') {
          owner.validateControl(socket, request.ownerFence);
          const targetId = request.params?.['targetId'];
          if (typeof targetId !== 'string') throw new Error('Exact handback target required');
          result = await handbacks.commit(socket, targetId, async () => {
            const grant = await owner.freeze(socket);
            const transaction = owner.holdFrozen(socket);
            let commitStarted = false;
            let committed = false;
            try {
              const session = leasedSessions.get(socket);
              if (typeof targetId !== 'string' || !session || !identity?.handback)
                throw new Error('Owner handback requires a named session and exact target');
              const { targetInfos } = await cdp.send<{
                targetInfos: Array<{ targetId: string; type: string; url: string }>;
              }>('Target.getTargets', undefined, null);
              const target = targetInfos.find(
                (item) => item.type === 'page' && item.targetId === targetId
              );
              if (!target) throw new Error('Owner handback target is missing');
              passive.revokeLogical(session);
              owner.assertCurrent(transaction);
              commitStarted = true;
              const bindingRevision = await identity.handback(
                session,
                targetId,
                target.url,
                grant.ownerEpoch,
                bindingRevisions.get(socket)
              );
              committed = true;
              return {
                confirmed: true,
                ...grant,
                targetId,
                refsInvalidated: true,
                pendingActions: 'drained',
                bindingRevision,
                observationEpoch: crypto.randomUUID(),
              };
            } finally {
              owner.finish(transaction, commitStarted && !committed);
              cleanupIdle(socket);
            }
          });
        } else if (request.method === 'daemon.ping') {
          result = {
            ok: true,
            daemonId: identity?.daemonId,
            endpointFingerprint: identity?.endpointFingerprint,
            protocolVersion: 2,
            ownerEpoch: owner.ownerEpoch,
          };
        } else if (request.method === 'daemon.status') {
          result = {
            ok: true,
            pid: process.pid,
            clientCount: clients.size,
            commandLeaseActive: owner.active,
            daemonId: identity?.daemonId,
            endpointFingerprint: identity?.endpointFingerprint,
            protocolVersion: 2,
            ownerEpoch: owner.ownerEpoch,
          };
        } else if (request.method === 'daemon.shutdown') {
          if (owner.active) throw new Error('session_busy: cannot shut down an active owner');
          const reason = request.params?.['reason'];
          if (reason !== undefined && reason !== 'recovery')
            throw new Error('Invalid daemon shutdown reason');
          result = { ok: true };
          shuttingDown = true;
          queueMicrotask(() => onShutdown?.(reason));
        } else if (request.method === 'daemon.detach' && request.params?.['sessionId']) {
          await sendToBrowser(
            'Target.detachFromTarget',
            { sessionId: String(request.params['sessionId']) },
            null
          );
          result = { ok: true };
        } else {
          result = await sendToBrowser(request.method, request.params, request.sessionId);
        }
        writeMessage(socket, { id: request.id, result });
      } catch (err) {
        if (
          err instanceof RuntimeResultError &&
          (request.method === 'Runtime.evaluate' || request.method === 'Runtime.callFunctionOn')
        ) {
          // Preserve the Runtime failure envelope across IPC so the command's
          // decoder retains exceptionDetails and the protocol-invalid code.
          writeMessage(socket, {
            id: request.id,
            result:
              err.code === 'RUNTIME_EXCEPTION'
                ? { result: { type: 'undefined' }, exceptionDetails: err.exceptionDetails }
                : { result: null },
          });
          return;
        }
        writeMessage(socket, { id: request.id, error: serializeError(err) });
      }
    };

    createLineReader(socket, (line: string) => {
      void handleRequestLine(line);
    });

    let disconnected = false;
    const disconnectClient = () => {
      if (disconnected) return;
      disconnected = true;
      cleanup.queueObservers(passive.takeCleanup(socket));
      passive.disconnect(socket);
      for (const [id, admission] of operations) {
        if (admission.client === socket) {
          owner.finish(admission, true);
          operations.delete(id);
        }
      }
      owner.disconnected(socket);
      cleanupIdle(socket);
      clients.delete(socket);
      daemonLog('info', `Client disconnected (total: ${clients.size})`);
    };
    // Revoke before acknowledging the peer's FIN, not only after our close event.
    socket.on('end', () => {
      disconnectClient();
      socket.destroy();
    });
    socket.on('close', disconnectClient);

    socket.on('error', (err: Error) => {
      daemonLog('warn', `Client socket error: ${err.message}`);
      clients.delete(socket);
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err: Error) => {
      daemonLog('error', `Server error: ${err.message}`);
      reject(err);
    });

    server.listen(socketPath, () => {
      try {
        chmodSync(socketPath, 0o600);
      } catch (error) {
        server.close(() => reject(error));
        return;
      }
      daemonLog('info', `Daemon server listening on ${socketPath}`);

      resolve({
        server,
        get clientCount() {
          return clients.size;
        },
        get commandLeaseActive() {
          return owner.active;
        },
        async close() {
          cdp.offAny(forwardEvent);
          unsubscribeAttached();
          for (const timer of fallbackTimers) {
            clearTimeout(timer);
          }
          fallbackTimers.clear();
          for (const client of clients) {
            client.destroy();
          }
          clients.clear();
          return new Promise<void>((res) => {
            server.close(() => {
              unlink(socketPath).catch(() => {});
              res();
            });
          });
        },
      });
    });
  });
}
