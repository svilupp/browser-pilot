/** Shared time, cancellation, and optional session context. */

/** Injectable time source for deadlines and cancellable waits. */
export interface Clock {
  /** Millisecond epoch timestamp. */
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Operation budget. Storage and ordinary operations do not need a session generation. */
export interface OperationContext {
  signal: AbortSignal;
  /** Absolute deadline in epoch milliseconds, measured by `clock.now()`. */
  deadline?: number;
  clock: Clock;
}

/** Host-owned session scope used to reject handles from previous executions. */
export interface ExecutionContext extends OperationContext {
  generation: string;
}
