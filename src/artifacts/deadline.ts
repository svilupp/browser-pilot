import type { OperationContext } from './types.ts';

/**
 * Combine `ctx.signal` and `ctx.deadline` (measured via `ctx.clock`) into a
 * single `AbortSignal` that fires whichever comes first. Callers must invoke
 * `dispose()` once done racing to release the internal timer.
 */
export function createDeadlineSignal(ctx: OperationContext): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();

  const onExternalAbort = (): void => {
    controller.abort(ctx.signal.reason);
  };

  if (ctx.signal.aborted) {
    controller.abort(ctx.signal.reason);
  } else {
    ctx.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let timerAbort: AbortController | undefined;

  if (ctx.deadline !== undefined && !controller.signal.aborted) {
    const remaining = ctx.deadline - ctx.clock.now();
    if (remaining <= 0) {
      controller.abort(new DOMException('Deadline exceeded', 'TimeoutError'));
    } else {
      timerAbort = new AbortController();
      ctx.clock
        .sleep(remaining, timerAbort.signal)
        .then(() => {
          if (!controller.signal.aborted) {
            controller.abort(new DOMException('Deadline exceeded', 'TimeoutError'));
          }
        })
        .catch(() => {
          // sleep was cancelled via dispose() — nothing to do.
        });
    }
  }

  const dispose = (): void => {
    ctx.signal.removeEventListener('abort', onExternalAbort);
    timerAbort?.abort();
  };

  return { signal: controller.signal, dispose };
}
