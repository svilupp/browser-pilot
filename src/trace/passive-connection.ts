import type { CDPClient } from '../cdp/client.ts';
import { createSessionScopedCDP } from '../cdp/session-scope.ts';
import { now as clockNow } from '../runtime/clock.ts';

export class TraceCleanupPendingError extends Error {
  constructor() {
    super('Trace cleanup_pending: waiting for exclusive controller ownership');
  }
}

export interface PassiveTraceConnection {
  readonly cdp: CDPClient;
  /** Finish installing the collector before returning controller ownership. */
  pauseControl(): Promise<void>;
  onRevoked(callback: () => void): () => void;
  /** Reacquire exclusive ownership before removing any instrumentation. */
  cleanup(stopCollector: () => Promise<unknown>): Promise<void>;
}

/** Trace telemetry carries no browser command authority while a capture is passive. */
export async function createPassiveTraceConnection(options: {
  cdp: CDPClient;
  targetId: string;
  session: string;
  viaDaemon: boolean;
  cleanupTimeoutMs?: number;
}): Promise<PassiveTraceConnection> {
  if (!options.viaDaemon)
    return {
      cdp: options.cdp,
      async pauseControl() {},
      onRevoked() {
        return () => {};
      },
      async cleanup(stop) {
        await stop();
      },
    };
  const result = await options.cdp.send<{ sessionId: string }>(
    'daemon.attachObserver',
    { targetId: options.targetId },
    null
  );
  if (!result.sessionId) throw new Error('Trace requires its own exact target attachment');
  const sessionId = result.sessionId;
  const cdp = createSessionScopedCDP(options.cdp, sessionId);
  let paused = false;
  let closed = false;
  const resume = async () => {
    if (!paused) return;
    const deadline = clockNow() + (options.cleanupTimeoutMs ?? 5000);
    while (true) {
      try {
        const grant = await options.cdp.send<{ rawCompatibility?: boolean }>(
          'daemon.acquireLease',
          { session: options.session },
          null,
          { timeout: Math.max(1, deadline - clockNow()) }
        );
        if (grant.rawCompatibility === false)
          throw new Error('Trace is unavailable under the strict action profile');
        paused = false;
        return;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('session_busy'))
          throw new Error('Trace owner unavailable; instrumentation cleanup remains incomplete');
        if (clockNow() >= deadline) throw new TraceCleanupPendingError();
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(50, deadline - clockNow()))
        );
      }
    }
  };
  return {
    cdp,
    onRevoked(callback) {
      const handler = (params: Record<string, unknown>) => {
        if (!closed && params['sessionId'] === sessionId && params['reason'] !== 'requested')
          callback();
      };
      options.cdp.on('daemon.subscriptionRevoked', handler);
      return () => options.cdp.off('daemon.subscriptionRevoked', handler);
    },
    async pauseControl() {
      if (closed) throw new Error('Trace connection is closed');
      if (paused) return;
      await options.cdp.send('daemon.subscribeEvents', { sessionId }, null);
      await options.cdp.send('daemon.releaseLease', undefined, null);
      paused = true;
    },
    async cleanup(stopCollector) {
      if (closed) return;
      // A passive listener may not issue even cleanup scripts until it owns a new grant.
      await resume();
      closed = true;
      try {
        await stopCollector();
      } finally {
        try {
          await options.cdp.send('Target.detachFromTarget', { sessionId }, null);
        } finally {
          await options.cdp.send('daemon.unsubscribeEvents', undefined, null);
          await options.cdp.send('daemon.releaseLease', undefined, null);
        }
      }
    },
  };
}
