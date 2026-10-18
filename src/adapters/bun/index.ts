import { openSocket } from '../../cdp/socket-transport.ts';
import type { TransportFactory } from '../../cdp/transport.ts';

/** Native Bun transport, including ephemeral handshake headers. */
export function createBunTransportFactory(): TransportFactory {
  return async (url, options = {}) => {
    if (options.signal?.aborted) throw new Error('WebSocket connection aborted');
    // Bun extends the constructor with handshake options; validate its standard socket contract.
    const socket: unknown =
      options.headers && Object.keys(options.headers).length
        ? Reflect.construct(WebSocket, [url, { headers: options.headers }])
        : new WebSocket(url);
    if (!(socket instanceof WebSocket)) throw new Error('Invalid Bun WebSocket');
    return openSocket(socket, options);
  };
}
