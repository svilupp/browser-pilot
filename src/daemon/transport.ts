/**
 * Daemon transport — a Transport implementation backed by a Unix domain socket.
 *
 * This allows existing CDPClient code to work transparently whether backed
 * by a direct WebSocket (normal path) or a Unix socket (daemon path).
 * The daemon proxies CDP messages, so the protocol shape is identical.
 */

import { connect as netConnect, type Socket } from 'node:net';
import type { Transport } from '../cdp/transport.ts';
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
        send(message: string) {
          if (!socket.writable) {
            throw new Error('Daemon socket is not writable');
          }
          socket.write(`${message}\n`);
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
