import { CapabilityError } from './ports.ts';

/** Bound a host operation even when the host ignores AbortSignal. Dispose late success. */
export function withinBudget<T>(
  pending: Promise<T>,
  options: { timeout?: number; signal?: AbortSignal },
  lateCleanup?: (value: T) => Promise<unknown> | void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () =>
      fail(new CapabilityError('cancelled', 'Host operation cancelled; outcome may be unknown'));
    const timer = setTimeout(
      () =>
        fail(
          new CapabilityError(
            'deadline',
            'Host operation deadline exceeded; outcome may be unknown'
          )
        ),
      options.timeout ?? 30000
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    void pending.then(
      (value) => {
        if (settled) {
          void Promise.resolve(lateCleanup?.(value)).catch(() => {});
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      }
    );
  });
}
