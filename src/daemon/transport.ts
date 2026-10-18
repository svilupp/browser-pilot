import { isRecord, jsonString, parseJsonRecord } from '../utils/json.ts';
/**
 * Daemon transport — a Transport implementation backed by a Unix domain socket.
 *
 * This allows existing CDPClient code to work transparently whether backed
 * by a direct WebSocket (normal path) or a Unix socket (daemon path).
 * The daemon proxies CDP messages, so the protocol shape is identical.
 */

import { connect as netConnect, type Socket } from 'node:net';
import type { Transport } from '../cdp/transport.ts';
import type { OwnerGrant } from '../owner/lease-controller.ts';
import { DAEMON_CONNECT_TIMEOUT_MS } from './types.ts';

/**
 * Create a Transport that communicates with the daemon over a Unix socket.
 *
 * @param socketPath - Path to the daemon's Unix domain socket
 * @param options - Connection options
 * @returns A Transport that can be used with createCDPClient
 */
export function createDaemonTransport(
  socketPath: string,
  options?: { timeout?: number }
): Promise<Transport> {
  const { timeout = DAEMON_CONNECT_TIMEOUT_MS } = options ?? {};

  return new Promise<Transport>((resolve, reject) => {
    const handleInitialError = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };
    const timer = setTimeout(() => {
      socket.off('error', handleInitialError);
      socket.destroy();
      reject(new Error(`Daemon connection timeout after ${timeout}ms`));
    }, timeout);

    const socket: Socket = netConnect(socketPath, () => {
      clearTimeout(timer);
      socket.off('error', handleInitialError);

      let buffer = '';
      let grant: OwnerGrant | undefined;
      let sequence = 0;
      const acquiring = new Set<number>();
      const beginning = new Set<number>();
      const ending = new Map<number, string>();
      const operations = new Set<string>();
      const messageHandlers: Array<(message: string) => void> = [];
      const closeHandlers: Array<() => void> = [];
      const errorHandlers: Array<(error: Error) => void> = [];

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        let newlineIdx = buffer.indexOf('\n');
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (line.length > 0) {
            const response = parseJsonRecord(line);
            const responseId = typeof response['id'] === 'number' ? response['id'] : undefined;
            const result = isRecord(response['result']) ? response['result'] : undefined;
            if (responseId !== undefined && beginning.delete(responseId)) {
              const id =
                typeof result?.['operationId'] === 'string' ? result['operationId'] : undefined;
              if (id) operations.add(id);
            }
            if (responseId !== undefined) {
              const id = ending.get(responseId);
              if (id) {
                operations.delete(id);
                ending.delete(responseId);
              }
            }
            if (responseId !== undefined && acquiring.delete(responseId) && result?.['grantId']) {
              if (grant?.grantId !== result['grantId'] || grant.ownerEpoch !== result['ownerEpoch'])
                sequence = 0;
              grant = {
                grantId: jsonString(result['grantId']),
                ownerEpoch: jsonString(result['ownerEpoch']),
              };
            }
            for (const handler of messageHandlers) {
              handler(line);
            }
          }
          newlineIdx = buffer.indexOf('\n');
        }
      });

      socket.on('close', () => {
        for (const handler of closeHandlers) {
          handler();
        }
      });

      socket.on('error', (err: Error) => {
        for (const handler of errorHandlers) {
          handler(err);
        }
      });

      const transport: Transport = {
        send(message: string, budget?: { timeoutMs: number }) {
          if (!socket.writable) {
            throw new Error('Daemon socket is not writable');
          }
          const request = parseJsonRecord(message);
          if (request['method'] === 'daemon.acquireLease') acquiring.add(request['id'] as number);
          if (request['method'] === 'daemon.beginOperation') beginning.add(request['id'] as number);
          if (request['method'] === 'daemon.endOperation')
            ending.set(
              request['id'] as number,
              (request['params'] as { operationId: string }).operationId
            );
          if (operations.size && request['method'] !== 'daemon.beginOperation')
            request['ownerOperationId'] = operations.values().next().value;
          if (grant) request['ownerFence'] = { ...grant, sequence: ++sequence };
          if (budget) request['ipcBudget'] = { timeoutMs: budget.timeoutMs, sentAt: Date.now() };
          socket.write(`${JSON.stringify(request)}\n`);
        },

        async close() {
          return new Promise<void>((resolveClose) => {
            if (socket.destroyed) {
              resolveClose();
              return;
            }
            socket.once('close', () => resolveClose());
            socket.end();
            // Fallback in case close event doesn't fire
            setTimeout(resolveClose, 200);
          });
        },

        onMessage(handler: (message: string) => void) {
          messageHandlers.push(handler);
        },

        onClose(handler: () => void) {
          closeHandlers.push(handler);
        },

        onError(handler: (error: Error) => void) {
          errorHandlers.push(handler);
        },
      };

      resolve(transport);
    });

    socket.once('error', handleInitialError);
  });
}
