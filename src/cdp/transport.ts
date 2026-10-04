import { openSocket } from './socket-transport.ts';
/**
 * WebSocket transport layer for CDP
 * Uses Web Standard WebSocket API for compatibility with Workers, Node, and Bun
 */

export interface Transport {
  send(message: string, budget?: { timeoutMs: number }): void;
  close(): Promise<void>;
  onMessage(handler: (message: string) => void): void | (() => void);
  onClose(handler: () => void): void | (() => void);
  onError(handler: (error: Error) => void): void | (() => void);
}

export interface TransportOptions {
  timeout?: number;
  signal?: AbortSignal;
  /** WebSocket handshake headers. Requires a header-capable host adapter. */
  headers?: Record<string, string>;
}

export type TransportFactory = (url: string, options?: TransportOptions) => Promise<Transport>;

/**
 * Create a WebSocket transport connection
 * Works in Node.js, Bun, Deno, and Cloudflare Workers
 */
export async function createTransport(
  wsUrl: string,
  options: TransportOptions = {}
): Promise<Transport> {
  if (options.headers && Object.keys(options.headers).length) {
    throw new Error(
      'Authenticated WebSockets require an injected host transportFactory (Node, Bun, or Workers adapter)'
    );
  }
  if (options.signal?.aborted) throw new Error('WebSocket connection aborted');
  return openSocket(new WebSocket(wsUrl), options);
}
