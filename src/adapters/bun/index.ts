import { openSocket } from '../../cdp/socket-transport.ts';
import type { TransportFactory } from '../../cdp/transport.ts';

/** Native Bun transport, including ephemeral handshake headers. */
export function createBunTransportFactory(): TransportFactory {
  return async (url, options = {}) => {
    if (options.signal?.aborted) throw new Error('WebSocket connection aborted');
    const Socket = WebSocket as unknown as new (
      url: string,
      options: { headers?: Record<string, string> }
    ) => WebSocket;
    const socket =
      options.headers && Object.keys(options.headers).length
        ? new Socket(url, { headers: options.headers })
        : new WebSocket(url);
    return openSocket(socket, options);
  };
}
