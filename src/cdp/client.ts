/**
 * CDP Client implementation
 * Handles command/response correlation and event subscription
 */

import { isRecord } from '../utils/json.ts';
import {
  CDPError,
  type CDPErrorData,
  type CDPEvent,
  type CDPRequest,
  type CDPResponse,
  type TargetInfo,
} from './protocol.ts';
import { createTransport, type TransportOptions } from './transport.ts';

/**
 * Payload delivered to `onTargetAttached` subscribers when a flat session is
 * attached (via auto-attach or an explicit `Target.attachToTarget`).
 * `sessionId` is the id of the NEWLY attached session — use it as the target
 * for subsequent `send(..., sessionId)` / `onSessionEvent(sessionId, ...)`.
 */
export interface TargetAttachedInfo {
  /** The flat session id of the newly attached target. */
  sessionId: string;
  /** Metadata about the attached target (frame/iframe/worker, url, etc.). */
  targetInfo: TargetInfo;
  /** True when the target is paused on start (waitForDebuggerOnStart). */
  waitingForDebugger: boolean;
}

export interface CDPClientOptions extends TransportOptions {
  /** Enable debug logging */
  debug?: boolean;
}

/** Per-call options for {@link CDPClient.send}. */
export interface CDPSendOptions {
  /**
   * Override the client-wide timeout (ms) for THIS call only. Use a short value
   * for probes that must not hang if the renderer is blocked (e.g. a frozen
   * print preview stalling every CDP call for the full default 30s).
   */
  timeout?: number;
}

export interface CDPClient {
  /** Send a CDP command and wait for response */
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string | null,
    options?: CDPSendOptions
  ): Promise<T>;

  /**
   * Subscribe to a CDP event on the DEFAULT session.
   *
   * Back-compat scope: a handler registered here fires for an event when the
   * event has NO sessionId (browser-level) OR its sessionId equals the current
   * default session (`currentSessionId`, i.e. the value returned by `sessionId`
   * / set by `attachToTarget` / `setSessionId`). Events belonging to other flat
   * sessions (e.g. OOPIF child sessions) are NOT delivered here — subscribe to
   * those with `onSessionEvent`. In the single-session world this is identical
   * to the previous "fire for every event" behavior.
   */
  on(event: string, handler: (params: Record<string, unknown>) => void): void;

  /** Unsubscribe from a default-session CDP event (pair of `on`). */
  off(event: string, handler: (params: Record<string, unknown>) => void): void;

  /**
   * Subscribe to a CDP event scoped to a SPECIFIC flat session. The handler
   * fires only for events whose sessionId matches `sessionId`. This is the
   * entry point for consuming events from OOPIF child sessions.
   * @returns an unsubscribe function.
   */
  onSessionEvent(
    sessionId: string,
    event: string,
    handler: (params: Record<string, unknown>) => void
  ): () => void;

  /**
   * Subscribe to ALL events (firehose, for debugging/logging). Fires for every
   * event on every session; the third argument is the event's sessionId (or
   * `undefined` for browser-level events).
   */
  onAny(
    handler: (method: string, params: Record<string, unknown>, sessionId?: string) => void
  ): void;

  /** Unsubscribe from the all-event firehose (pair of `onAny`). */
  offAny(
    handler: (method: string, params: Record<string, unknown>, sessionId?: string) => void
  ): void;

  /**
   * Subscribe to `Target.attachedToTarget` for newly attached flat sessions
   * (produced by `setAutoAttach` or explicit attaches). Use the `sessionId` in
   * the payload to drive the new session.
   * @returns an unsubscribe function.
   */
  onTargetAttached(handler: (info: TargetAttachedInfo) => void): () => void;

  /** Close the CDP connection */
  close(): Promise<void>;

  /** Attach to a target and return session ID */
  attachToTarget(targetId: string): Promise<string>;

  /**
   * Enable flat auto-attach so that child targets (e.g. cross-origin iframes /
   * OOPIFs) automatically attach as new flat sessions and pause on start
   * (`waitForDebuggerOnStart: true`, released via `runIfWaitingForDebugger`).
   * The target session defaults to the current default session; pass
   * `{ sessionId: null }` to configure it browser-level, or a specific session
   * id to configure a particular (e.g. child) session for nested auto-attach.
   */
  setAutoAttach(opts?: { sessionId?: string | null }): Promise<void>;

  /**
   * Release a session that is paused on start (from auto-attach's
   * `waitForDebuggerOnStart`) so it resumes executing.
   */
  runIfWaitingForDebugger(sessionId: string): Promise<void>;

  /**
   * Live set of flat session ids currently attached, maintained from
   * `Target.attachedToTarget` / `Target.detachedFromTarget` (and explicit
   * `attachToTarget` calls). Read-only view.
   */
  readonly sessions: ReadonlySet<string>;

  /** True if `sessionId` is currently in the live-session registry. */
  hasSession(sessionId: string): boolean;

  /** Get the current session ID (after attaching to target) */
  readonly sessionId: string | undefined;

  /** Override the current session ID when reusing an existing attached target */
  setSessionId(sessionId: string | undefined): void;

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
type AnyEventHandler = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string
) => void;
type TargetAttachedHandler = (info: TargetAttachedInfo) => void;

/**
 * Create a CDP client from an already-connected transport.
 * Used by the daemon fast-path (Unix socket transport).
 */
export function createCDPClientFromTransport(
  transport: import('./transport.ts').Transport,
  options: CDPClientOptions = {}
): CDPClient {
  return buildCDPClient(transport, options);
}

/**
 * Create a new CDP client connected to the given WebSocket URL
 */
export async function createCDPClient(
  wsUrl: string,
  options: CDPClientOptions = {}
): Promise<CDPClient> {
  const { timeout = 30000 } = options;

  const transport = await createTransport(wsUrl, { timeout });
  return buildCDPClient(transport, options);
}

/**
 * Internal: build a CDPClient from a Transport instance.
 */
function buildCDPClient(
  transport: import('./transport.ts').Transport,
  options: CDPClientOptions = {}
): CDPClient {
  const { debug = false, timeout = 30000 } = options;

  let messageId = 0;
  let currentSessionId: string | undefined;
  let connected = true;

  const pending = new Map<number, PendingRequest>();
  // Legacy, default-session-scoped handlers keyed by event method.
  const eventHandlers = new Map<string, Set<EventHandler>>();
  // Session-scoped handlers: sessionId -> method -> handlers.
  const sessionEventHandlers = new Map<string, Map<string, Set<EventHandler>>>();
  const anyEventHandlers = new Set<AnyEventHandler>();
  const targetAttachedHandlers = new Set<TargetAttachedHandler>();
  // Live registry of attached flat session ids (auto-attach + explicit attach).
  const liveSessions = new Set<string>();

  // Handle incoming messages
  transport.onMessage((raw: string) => {
    let msg: CDPResponse | CDPEvent;

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) {
        if (debug) console.error('[CDP] Ignoring non-object message:', raw);
        return;
      }
      if ('id' in parsed && typeof parsed['id'] === 'number') {
        msg = parsed as unknown as CDPResponse;
      } else if ('method' in parsed && typeof parsed['method'] === 'string') {
        msg = parsed as unknown as CDPEvent;
      } else {
        if (debug) console.error('[CDP] Ignoring invalid message shape:', raw);
        return;
      }
    } catch {
      if (debug) console.error('[CDP] Failed to parse message:', raw);
      return;
    }

    if (debug) {
      console.log('[CDP] <--', JSON.stringify(msg, null, 2).slice(0, 500));
    }

    // Response to a command (has id)
    if ('id' in msg && typeof msg.id === 'number') {
      const response = msg;
      const request = pending.get(response.id);

      if (request) {
        pending.delete(response.id);
        clearTimeout(request.timer);

        if (response.error) {
          const error: CDPErrorData =
            typeof response.error === 'string'
              ? { code: -32000, message: response.error }
              : response.error;
          request.reject(new CDPError(error));
        } else {
          request.resolve(response.result);
        }
      }
      return;
    }

    // Event (has method but no id)
    if ('method' in msg) {
      const event = msg;
      const params = event.params ?? {};
      // The session the event belongs to (undefined = browser-level / default).
      const eventSessionId = event.sessionId;

      // Internal target lifecycle: keep the live-session registry accurate and
      // notify onTargetAttached subscribers. Handled independently of routing so
      // nested attaches (whose message-level sessionId is the PARENT) are still
      // tracked; the new session's id lives in params.sessionId.
      if (event.method === 'Target.attachedToTarget') {
        const attachedSessionId = params['sessionId'];
        if (typeof attachedSessionId === 'string') {
          liveSessions.add(attachedSessionId);
          if (targetAttachedHandlers.size > 0) {
            const info: TargetAttachedInfo = {
              sessionId: attachedSessionId,
              targetInfo: params['targetInfo'] as TargetInfo,
              waitingForDebugger: params['waitingForDebugger'] === true,
            };
            for (const handler of targetAttachedHandlers) {
              try {
                handler(info);
              } catch (e) {
                if (debug) console.error('[CDP] Error in onTargetAttached handler:', e);
              }
            }
          }
        }
      } else if (event.method === 'Target.detachedFromTarget') {
        const detachedSessionId = params['sessionId'];
        if (typeof detachedSessionId === 'string') {
          liveSessions.delete(detachedSessionId);
        }
      }

      // Firehose (debugging/logging): every event on every session, now with
      // the originating sessionId.
      for (const handler of anyEventHandlers) {
        try {
          handler(event.method, params, eventSessionId);
        } catch (e) {
          if (debug) console.error('[CDP] Error in any-event handler:', e);
        }
      }

      // Session-scoped subscribers (onSessionEvent): only when the event carries
      // a sessionId that someone is listening on.
      if (eventSessionId !== undefined) {
        const sessionHandlers = sessionEventHandlers.get(eventSessionId)?.get(event.method);
        if (sessionHandlers) {
          for (const handler of sessionHandlers) {
            try {
              handler(params);
            } catch (e) {
              if (debug)
                console.error(
                  `[CDP] Error in session handler for ${eventSessionId}/${event.method}:`,
                  e
                );
            }
          }
        }
      }

      // Legacy default-session handlers (on): back-compat scope = events with no
      // sessionId (browser-level) OR belonging to the current default session.
      // This keeps single-session behavior identical while preventing child
      // (OOPIF) session events from leaking into main-page handlers.
      if (eventSessionId === undefined || eventSessionId === currentSessionId) {
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
      sessionId?: string | null,
      options?: CDPSendOptions
    ): Promise<T> {
      if (!connected) {
        throw new Error('CDP client is not connected');
      }

      const effectiveTimeout = options?.timeout ?? timeout;

      const id = ++messageId;
      const effectiveSessionId = sessionId === null ? undefined : (sessionId ?? currentSessionId);

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
          reject(new Error(`CDP command ${method} timed out after ${effectiveTimeout}ms`));
        }, effectiveTimeout);

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

    onSessionEvent(sessionId: string, event: string, handler: EventHandler): () => void {
      let methodMap = sessionEventHandlers.get(sessionId);
      if (!methodMap) {
        methodMap = new Map();
        sessionEventHandlers.set(sessionId, methodMap);
      }
      let handlers = methodMap.get(event);
      if (!handlers) {
        handlers = new Set();
        methodMap.set(event, handlers);
      }
      handlers.add(handler);

      return () => {
        const map = sessionEventHandlers.get(sessionId);
        const set = map?.get(event);
        if (!set) return;
        set.delete(handler);
        if (set.size === 0) map?.delete(event);
        if (map && map.size === 0) sessionEventHandlers.delete(sessionId);
      };
    },

    onAny(handler: AnyEventHandler) {
      anyEventHandlers.add(handler);
    },

    offAny(handler: AnyEventHandler) {
      anyEventHandlers.delete(handler);
    },

    onTargetAttached(handler: TargetAttachedHandler): () => void {
      targetAttachedHandlers.add(handler);
      return () => {
        targetAttachedHandlers.delete(handler);
      };
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
      // Register deterministically; a Target.attachedToTarget event may also
      // arrive, but adding to a Set is idempotent.
      liveSessions.add(result.sessionId);
      return result.sessionId;
    },

    async setAutoAttach(opts?: { sessionId?: string | null }): Promise<void> {
      // Default (no opts) targets the current default session via send()'s
      // sessionId=undefined semantics; an explicit `null` targets browser-level;
      // an explicit id targets that (e.g. child) session for nested auto-attach.
      const target = opts?.sessionId;
      await this.send(
        'Target.setAutoAttach',
        { autoAttach: true, flatten: true, waitForDebuggerOnStart: true },
        target
      );
    },

    async runIfWaitingForDebugger(sessionId: string): Promise<void> {
      await this.send('Runtime.runIfWaitingForDebugger', undefined, sessionId);
    },

    get sessions(): ReadonlySet<string> {
      return liveSessions;
    },

    hasSession(sessionId: string): boolean {
      return liveSessions.has(sessionId);
    },

    get sessionId() {
      return currentSessionId;
    },

    setSessionId(sessionId: string | undefined) {
      currentSessionId = sessionId;
    },

    get isConnected() {
      return connected;
    },
  };

  return client;
}

export { CDPError };
