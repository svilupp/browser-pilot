/**
 * WebSocket transport layer for CDP
 * Uses Web Standard WebSocket API for compatibility with Workers, Node, and Bun
 */

export interface Transport {
  send(message: string): void;
  close(): Promise<void>;
  onMessage(handler: (message: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: Error) => void): void;
}

export interface TransportOptions {
  timeout?: number;
}

/**
 * Create a WebSocket transport connection
 * Works in Node.js, Bun, Deno, and Cloudflare Workers
 */
export function createTransport(wsUrl: string, options: TransportOptions = {}): Promise<Transport> {
  const { timeout = 30000 } = options;

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`WebSocket connection timeout after ${timeout}ms`));
    }, timeout);

    const ws = new WebSocket(wsUrl);

    const messageHandlers: Array<(message: string) => void> = [];
    const closeHandlers: Array<() => void> = [];
    const errorHandlers: Array<(error: Error) => void> = [];

    ws.addEventListener('open', () => {
      clearTimeout(timeoutId);

      const transport: Transport = {
        send(message: string) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(message);
          } else {
            throw new Error(
              `Cannot send message, WebSocket is ${getReadyStateString(ws.readyState)}`
            );
          }
        },

        async close() {
          return new Promise<void>((resolveClose) => {
            if (ws.readyState === WebSocket.CLOSED) {
              resolveClose();
              return;
            }

            let settled = false;
            let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
            const finish = () => {
              if (settled) return;
              settled = true;
              if (fallbackTimer) clearTimeout(fallbackTimer);
              ws.removeEventListener('close', onClose);
              resolveClose();
            };

            const onClose = () => {
              finish();
            };

            ws.addEventListener('close', onClose);

            try {
              if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
              }
            } catch {
              finish();
              return;
            }

            // Some runtimes delay or skip the close event for client-initiated
            // disconnects. Don't impose a multi-second tax on every CLI call.
            fallbackTimer = setTimeout(finish, 200);
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

    ws.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data);
      for (const handler of messageHandlers) {
        handler(data);
      }
    });

    ws.addEventListener('close', () => {
      for (const handler of closeHandlers) {
        handler();
      }
    });

    ws.addEventListener('error', (_event) => {
      clearTimeout(timeoutId);
      const error = new Error('WebSocket connection error');
      for (const handler of errorHandlers) {
        handler(error);
      }
      // Only reject if we haven't resolved yet (during connection phase)
      reject(error);
    });
  });
}

function getReadyStateString(state: number): string {
  switch (state) {
    case WebSocket.CONNECTING:
      return 'CONNECTING';
    case WebSocket.OPEN:
      return 'OPEN';
    case WebSocket.CLOSING:
      return 'CLOSING';
    case WebSocket.CLOSED:
      return 'CLOSED';
    default:
      return 'UNKNOWN';
  }
}
