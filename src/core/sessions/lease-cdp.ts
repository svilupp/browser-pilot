import type { CDPClient, CDPSendOptions } from '../../cdp/client.ts';
import { CDPError } from '../../cdp/protocol.ts';
import { CapabilityError, type ExecutionContext } from '../ports.ts';

/** Local CDP view whose listener and cancellation scope ends with one borrow. */
export function createLeaseCDP(client: CDPClient, ctx: ExecutionContext): CDPClient {
  const subscriptions: Array<() => void> = [];
  let detached = false;
  let closePromise: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  const attachments = new Set<string>();
  const admit = () => {
    if (detached) throw new CapabilityError('stale_handle', 'Browser lease detached');
    if (ctx.signal.aborted) throw new CapabilityError('cancelled', 'Browser lease cancelled');
    if (ctx.deadline !== undefined && ctx.clock.now() >= ctx.deadline)
      throw new CapabilityError('deadline', 'Browser lease deadline exceeded');
  };
  const overrides = {
    send<T>(
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string | null,
      options?: CDPSendOptions
    ): Promise<T> {
      admit();
      if (options?.signal?.aborted)
        throw new CapabilityError('cancelled', 'CDP command cancelled before dispatch');
      const remaining = ctx.deadline === undefined ? undefined : ctx.deadline - ctx.clock.now();
      let signal = ctx.signal;
      let cleanupSignals = () => {};
      if (options?.signal && options.signal !== ctx.signal) {
        const callerSignal = options.signal;
        const combined = new AbortController();
        const onOwnerAbort = () => combined.abort(ctx.signal.reason);
        const onCallerAbort = () => combined.abort(callerSignal.reason);
        ctx.signal.addEventListener('abort', onOwnerAbort, { once: true });
        callerSignal.addEventListener('abort', onCallerAbort, { once: true });
        cleanupSignals = () => {
          ctx.signal.removeEventListener('abort', onOwnerAbort);
          callerSignal.removeEventListener('abort', onCallerAbort);
        };
        signal = combined.signal;
      }
      let operation: Promise<T>;
      try {
        operation = client.send<T>(method, params, sessionId, {
          ...options,
          signal,
          ...(remaining === undefined
            ? {}
            : { timeout: Math.min(options?.timeout ?? remaining, remaining) }),
        });
      } catch (error) {
        cleanupSignals();
        throw error;
      }
      const tracked = operation.then((result) => {
        if (
          method === 'Target.attachToTarget' &&
          typeof result === 'object' &&
          result !== null &&
          'sessionId' in result &&
          typeof result.sessionId === 'string'
        )
          attachments.add(result.sessionId);
        return result;
      });
      const settled = tracked.then(cleanupSignals, cleanupSignals);
      pending.add(settled);
      void settled.then(() => pending.delete(settled));
      return tracked;
    },
    on(event: string, handler: Parameters<CDPClient['on']>[1]) {
      admit();
      client.on(event, handler);
      subscriptions.push(() => client.off(event, handler));
    },
    onAny(handler: Parameters<CDPClient['onAny']>[0]) {
      admit();
      client.onAny(handler);
      subscriptions.push(() => client.offAny(handler));
    },
    onSessionEvent(...args: Parameters<CDPClient['onSessionEvent']>) {
      admit();
      const unsubscribe = client.onSessionEvent(...args);
      subscriptions.push(unsubscribe);
      return unsubscribe;
    },
    onTargetAttached(handler: Parameters<CDPClient['onTargetAttached']>[0]) {
      admit();
      const unsubscribe = client.onTargetAttached(handler);
      subscriptions.push(unsubscribe);
      return unsubscribe;
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      detached = true;
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
      // Closing local admission cannot cancel a command already dispatched to
      // the browser. Keep ownership fenced until those requests settle.
      closePromise = Promise.allSettled(pending).then(async () => {
        if (!client.isConnected) return;
        // Detaching each explicit attachment also removes its auto-attached
        // children. Otherwise debugger waits outlive the Page listeners.
        await Promise.all(
          [...attachments].map((sessionId) =>
            client
              .send('Target.detachFromTarget', { sessionId }, null, { timeout: 1000 })
              .catch((error: unknown) => {
                // Closing a tab already detached its sessions. Preserve actual
                // cleanup failures while allowing that normal lifecycle race.
                if (
                  error instanceof CDPError &&
                  /^(No session with given id|Session with given id not found)$/.test(
                    error.message
                  ) &&
                  !client.hasSession(sessionId)
                )
                  return;
                throw error;
              })
          )
        );
        attachments.clear();
      });
      return closePromise;
    },
  };
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property in overrides) return overrides[property as keyof typeof overrides];
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(receiver) : value;
    },
  });
}
