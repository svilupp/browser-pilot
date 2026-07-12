/**
 * Daemon Unix socket server
 *
 * Accepts connections from CLI clients on a Unix domain socket.
 * Each client gets CDP events forwarded in real-time and can send
 * CDP commands that are proxied to Chrome via the persistent WebSocket.
 */

import { unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import type { CDPClient } from '../cdp/client.ts';
import { CDPError, type CDPErrorData } from '../cdp/protocol.ts';
import { daemonLog } from './lifecycle.ts';
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
    request.method.length > 0
  );
}

function serializeError(error: unknown): CDPErrorData {
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
  /** Close the server and all client connections */
  close(): Promise<void>;
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
  onActivity: () => void
): Promise<DaemonServer> {
  // Clean up stale socket file if it exists
  await unlink(socketPath).catch(() => {});

  const clients = new Set<Socket>();

  // Forward all CDP events to all connected clients. The sessionId is carried
  // through so the CLI's CDP client can route session-scoped events (OOPIF child
  // sessions) correctly instead of leaking them into main-page handlers.
  const forwardEvent = (method: string, params: Record<string, unknown>, sessionId?: string) => {
    const event: DaemonEvent = { method, params, sessionId };
    for (const client of clients) {
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
        const result = await cdp.send(request.method, request.params, request.sessionId);
        writeMessage(socket, { id: request.id, result });
      } catch (err) {
        writeMessage(socket, { id: request.id, error: serializeError(err) });
      }
    };

    createLineReader(socket, (line: string) => {
      void handleRequestLine(line);
    });

    socket.on('close', () => {
      clients.delete(socket);
      daemonLog('info', `Client disconnected (total: ${clients.size})`);
    });

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
      daemonLog('info', `Daemon server listening on ${socketPath}`);

      resolve({
        server,
        get clientCount() {
          return clients.size;
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
