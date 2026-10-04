import { type MessageSocket, openSocket } from '../../cdp/socket-transport.ts';
import type { TransportFactory } from '../../cdp/transport.ts';
import { CapabilityError } from '../../core/ports.ts';

/** Load the optional peer before allocation; returned factory supports authenticated handshakes. */
export async function createNodeTransportFactory(): Promise<TransportFactory> {
  let Socket: typeof import('ws').default;
  try {
    Socket = (await import('ws')).default;
  } catch {
    throw new CapabilityError(
      'transport',
      'Node authenticated CDP requires ws. Install it with: npm install browser-pilot ws'
    );
  }
  return async (url, options = {}) => {
    if (options.signal?.aborted) throw new Error('WebSocket connection aborted');
    const socket = new Socket(url, {
      headers: options.headers,
      followRedirects: false,
      handshakeTimeout: options.timeout ?? 30000,
      maxPayload: 32 * 1024 * 1024,
    });
    // ws emits EventEmitter errors as well as ErrorEvents. Always consume them,
    // including failures after cancellation while the handshake is unwinding.
    socket.on('error', () => {});
    return openSocket(socket as unknown as MessageSocket, options);
  };
}
