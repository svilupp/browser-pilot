/**
 * Session-scoped view of a CDPClient.
 *
 * Pins a client to a FIXED flat session id so a Page's session-omitting
 * `send`/`on` calls resolve against ITS OWN target instead of the client's
 * mutable "current default session" (which follows the most recent
 * `attachToTarget`/`setSessionId`). Without this, once a second target is
 * attached a Page's reads, actions, and events are no longer guaranteed to stay
 * on its own target.
 *
 * The wrapper is transparent and preserves existing semantics:
 * - `send(method, params)` with the sessionId OMITTED → pinned session.
 * - `send(method, params, childSessionId)` with an explicit id (OOPIF child) →
 *   passed through unchanged.
 * - `send(method, params, null)` (browser-level) → passed through as `null`.
 * - `on(event, handler)` fires for events with NO sessionId (browser-level) OR
 *   whose sessionId === the pinned session — the same back-compat scope as the
 *   underlying `on()`, but pinned instead of following the mutable global.
 * - Every other member delegates straight to the underlying client.
 *
 * When only one target is attached the pinned session equals the client's
 * current default session, so behaviour is identical to using the client
 * directly.
 */

import type { CDPClient, CDPSendOptions } from './client.ts';

type EventHandler = (params: Record<string, unknown>) => void;
type AnyEventHandler = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string
) => void;

/**
 * Build a session-scoped view of `client` pinned to `pinnedSessionId`.
 * The returned object implements the full `CDPClient` interface.
 */
export function createSessionScopedCDP(client: CDPClient, pinnedSessionId: string): CDPClient {
  // (event method) -> (original handler -> wrapped firehose handler). Lets
  // off() remove exactly the listener on() installed, and makes re-registering
  // the same (event, handler) idempotent, mirroring the underlying Set-based
  // on().
  const onWrappers = new Map<string, Map<EventHandler, AnyEventHandler>>();

  const scoped: CDPClient = {
    send<T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string | null,
      options?: CDPSendOptions
    ): Promise<T> {
      // Omitted (undefined) → pinned session. An explicit id (OOPIF child) or
      // an explicit null (browser-level) passes through unchanged.
      const effectiveSessionId = sessionId === undefined ? pinnedSessionId : sessionId;
      return client.send<T>(method, params, effectiveSessionId, options);
    },

    on(event: string, handler: EventHandler): void {
      let byHandler = onWrappers.get(event);
      if (!byHandler) {
        byHandler = new Map();
        onWrappers.set(event, byHandler);
      }
      // Idempotent, matching the underlying Set-based on(): the same handler on
      // the same event registers once.
      if (byHandler.has(handler)) return;

      const wrapped: AnyEventHandler = (eventMethod, params, eventSessionId) => {
        if (
          eventMethod === event &&
          (eventSessionId === undefined || eventSessionId === pinnedSessionId)
        ) {
          handler(params);
        }
      };
      byHandler.set(handler, wrapped);
      client.onAny(wrapped);
    },

    off(event: string, handler: EventHandler): void {
      const byHandler = onWrappers.get(event);
      if (!byHandler) return;
      const wrapped = byHandler.get(handler);
      if (!wrapped) return;
      client.offAny(wrapped);
      byHandler.delete(handler);
      if (byHandler.size === 0) onWrappers.delete(event);
    },

    onSessionEvent(sessionId, event, handler) {
      return client.onSessionEvent(sessionId, event, handler);
    },

    onAny(handler) {
      client.onAny(handler);
    },

    offAny(handler) {
      client.offAny(handler);
    },

    onTargetAttached(handler) {
      return client.onTargetAttached(handler);
    },

    close() {
      return client.close();
    },

    attachToTarget(targetId) {
      return client.attachToTarget(targetId);
    },

    setAutoAttach(opts) {
      // Pin the target the same way send() does: an OMITTED sessionId arms
      // auto-attach on THIS view's pinned session (not the client's mutable
      // default, which may have moved to a concurrently-initializing Page); an
      // explicit id (OOPIF child) targets that session; an explicit `null`
      // targets browser-level. Distinguish undefined from null so browser-level
      // is preserved.
      const effectiveSessionId = opts?.sessionId === undefined ? pinnedSessionId : opts.sessionId;
      return client.setAutoAttach({ ...opts, sessionId: effectiveSessionId });
    },

    runIfWaitingForDebugger(sessionId) {
      return client.runIfWaitingForDebugger(sessionId);
    },

    get sessions() {
      return client.sessions;
    },

    hasSession(sessionId) {
      return client.hasSession(sessionId);
    },

    get sessionId() {
      return pinnedSessionId;
    },

    setSessionId(_sessionId) {
      // A scoped view is pinned to a fixed session by construction. Mutating the
      // underlying client's global default session through a scoped view would
      // silently affect every other view sharing the client, defeating the
      // isolation this wrapper exists to provide. No caller does this today; if
      // one appears, fail loudly rather than corrupt sibling views.
      throw new Error(
        'setSessionId() is not supported on a session-scoped CDP view: it is pinned ' +
          `to session "${pinnedSessionId}". Call setSessionId on the underlying client instead.`
      );
    },

    get isConnected() {
      return client.isConnected;
    },
  };

  return scoped;
}
