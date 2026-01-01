/**
 * CDP Client implementation
 * Handles command/response correlation and event subscription
 */

import { CDPError, type CDPEvent, type CDPRequest, type CDPResponse } from './protocol.ts';
import { createTransport, type TransportOptions } from './transport.ts';

export interface CDPClientOptions extends TransportOptions {
  /** Enable debug logging */
  debug?: boolean;
}

export interface CDPClient {
  /** Send a CDP command and wait for response */
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<T>;

  /** Subscribe to a CDP event */
  on(event: string, handler: (params: Record<string, unknown>) => void): void;

  /** Unsubscribe from a CDP event */
  off(event: string, handler: (params: Record<string, unknown>) => void): void;

  /** Subscribe to all events (for debugging/logging) */
  onAny(handler: (method: string, params: Record<string, unknown>) => void): void;

  /** Close the CDP connection */
  close(): Promise<void>;

  /** Attach to a target and return session ID */
  attachToTarget(targetId: string): Promise<string>;

  /** Get the current session ID (after attaching to target) */
  readonly sessionId: string | undefined;

  /** Check if connection is open */
  readonly isConnected: boolean;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
}

type EventHandler = (params: Record<string, unknown>) => void;
type AnyEventHandler = (method: string, params: Record<string, unknown>) => void;

/**
 * Create a new CDP client connected to the given WebSocket URL
 */
export async function createCDPClient(
  wsUrl: string,
  options: CDPClientOptions = {}
): Promise<CDPClient> {
  const { debug = false, timeout = 30000 } = options;

  const transport = await createTransport(wsUrl, { timeout });

  let messageId = 0;
  let currentSessionId: string | undefined;
  let connected = true;

  const pending = new Map<number, PendingRequest>();
  const eventHandlers = new Map<string, Set<EventHandler>>();
  const anyEventHandlers = new Set<AnyEventHandler>();

  // Handle incoming messages
  transport.onMessage((raw: string) => {
    let msg: CDPResponse | CDPEvent;

    try {
      msg = JSON.parse(raw);
    } catch {
      if (debug) console.error('[CDP] Failed to parse message:', raw);
      return;
    }

    if (debug) {
      console.log('[CDP] <--', JSON.stringify(msg, null, 2).slice(0, 500));
    }

    // Response to a command (has id)
    if ('id' in msg && typeof msg.id === 'number') {
      const response = msg as CDPResponse;
      const request = pending.get(response.id);

      if (request) {
        pending.delete(response.id);
        clearTimeout(request.timer);

        if (response.error) {
          request.reject(new CDPError(response.error));
        } else {
          request.resolve(response.result);
        }
      }
      return;
    }

    // Event (has method but no id)
    if ('method' in msg) {
      const event = msg as CDPEvent;
      const params = event.params ?? {};

      // Notify any-event handlers
      for (const handler of anyEventHandlers) {
        try {
          handler(event.method, params);
        } catch (e) {
          if (debug) console.error('[CDP] Error in any-event handler:', e);
        }
      }

      // Notify specific event handlers
      const handlers = eventHandlers.get(event.method);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(params);
          } catch (e) {
            if (debug) console.error(`[CDP] Error in handler for ${event.method}:`, e);
          }
        }
      }
    }
  });

  transport.onClose(() => {
    connected = false;

    // Reject all pending requests
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(new Error('WebSocket connection closed'));
      pending.delete(id);
    }
  });

  transport.onError((error: Error) => {
    if (debug) console.error('[CDP] Transport error:', error);
  });

  const client: CDPClient = {
    async send<T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string
    ): Promise<T> {
      if (!connected) {
        throw new Error('CDP client is not connected');
      }

      const id = ++messageId;
      const effectiveSessionId = sessionId ?? currentSessionId;

      const request: CDPRequest = { id, method };
      if (params !== undefined) {
        request.params = params;
      }
      if (effectiveSessionId !== undefined) {
        request.sessionId = effectiveSessionId;
      }

      const message = JSON.stringify(request);

      if (debug) {
        console.log('[CDP] -->', message.slice(0, 500));
      }

      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP command ${method} timed out after ${timeout}ms`));
        }, timeout);

        pending.set(id, {
          resolve: resolve as (result: unknown) => void,
          reject,
          method,
          timer,
        });

        try {
          transport.send(message);
        } catch (e) {
          pending.delete(id);
          clearTimeout(timer);
          reject(e);
        }
      });
    },

    on(event: string, handler: EventHandler) {
      let handlers = eventHandlers.get(event);
      if (!handlers) {
        handlers = new Set();
        eventHandlers.set(event, handlers);
      }
      handlers.add(handler);
    },

    off(event: string, handler: EventHandler) {
      const handlers = eventHandlers.get(event);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          eventHandlers.delete(event);
        }
      }
    },

    onAny(handler: AnyEventHandler) {
      anyEventHandlers.add(handler);
    },

    async close() {
      connected = false;
      await transport.close();
    },

    async attachToTarget(targetId: string): Promise<string> {
      const result = await this.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      currentSessionId = result.sessionId;
      return result.sessionId;
    },

    get sessionId() {
      return currentSessionId;
    },

    get isConnected() {
      return connected;
    },
  };

  return client;
}

export { CDPError };
