/**
 * Retry utilities for flaky browser tests
 */

export interface RetryOptions {
  /** Number of retry attempts (default: 2) */
  retries?: number;
  /** Capture screenshot on final failure (default: true) */
  screenshotOnFailure?: boolean;
  /** Custom backoff delays in ms (default: [100, 200]) */
  backoff?: number[];
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  retries: 2,
  screenshotOnFailure: true,
  backoff: [100, 200],
};

/**
 * Execute a function with automatic retry on failure
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === opts.retries) {
        // Final failure - enhance error message
        const enhanced = new Error(
          `Test failed after ${opts.retries + 1} attempts: ${lastError.message}`
        );
        enhanced.cause = lastError;
        enhanced.stack = lastError.stack;
        throw enhanced;
      }

      // Wait before retry with backoff
      const delay = opts.backoff[attempt] ?? opts.backoff[opts.backoff.length - 1] ?? 100;
      await Bun.sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Create a test function wrapper with automatic retry
 */
export function retryable(
  testFn: () => Promise<void>,
  options?: RetryOptions
): () => Promise<void> {
  return async () => {
    await withRetry(testFn, options);
  };
}

/**
 * Retry a specific assertion until it passes or times out
 */
export async function waitUntil(
  condition: () => Promise<boolean> | boolean,
  options: { timeout?: number; interval?: number; message?: string } = {}
): Promise<void> {
  const { timeout = 5000, interval = 100, message = 'Condition not met' } = options;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      if (await condition()) {
        return;
      }
    } catch {
      // Condition threw, keep trying
    }
    await Bun.sleep(interval);
  }

  throw new Error(`Timeout: ${message} (waited ${timeout}ms)`);
}
