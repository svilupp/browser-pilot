/**
 * Centralized environment variable access.
 *
 * All env reads in library code should go through this module so that
 * ast-grep can enforce the boundary and tests can inject overrides.
 */

function getProcessEnv(): Record<string, string | undefined> {
  if (typeof globalThis.process !== 'undefined' && globalThis.process.env) {
    return globalThis.process.env;
  }
  return {};
}

/**
 * Shared overrides for tests or host initialization. Values take precedence
 * over the process environment and are never logged here.
 *
 * This is module-level state, not request-local configuration. Concurrent
 * callers should pass credentials through connection options instead of
 * setting and clearing overrides around each request. Portable connections
 * do not read this layer.
 */
let envOverrides: Record<string, string | undefined> = {};

/** Merge overrides into the active override layer. Values take precedence over `process.env`. */
export function setEnvOverrides(overrides: Record<string, string | undefined>): void {
  envOverrides = { ...envOverrides, ...overrides };
}

/**
 * Clear all active overrides, reverting `getEnv`/`requireEnv` to `process.env`
 * only. Intended for test teardown (single-threaded, single-tenant); do not
 * call this per-request in a concurrent server/Worker context — see the
 * module doc comment above.
 */
export function clearEnvOverrides(): void {
  envOverrides = {};
}

/**
 * Run `fn` with `overrides` merged on top of the current overrides, restoring
 * the previous overrides afterward (even if `fn` throws or rejects).
 *
 * Like `setEnvOverrides`/`clearEnvOverrides`, this mutates a single shared
 * module-level layer, so concurrent callers on the same isolate can still
 * interleave and observe each other's overrides mid-flight. Safe for
 * single-threaded test code; for concurrent request handling prefer passing
 * credentials explicitly instead.
 */
export async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T> | T
): Promise<T> {
  const previous = envOverrides;
  envOverrides = { ...previous, ...overrides };
  try {
    return await fn();
  } finally {
    envOverrides = previous;
  }
}

/** Read an override or process environment value; undefined when neither is present. */
export function getEnv(name: string): string | undefined {
  if (name in envOverrides) return envOverrides[name];
  return getProcessEnv()[name];
}

/** Read an environment variable, throwing if missing. */
export function requireEnv(name: string): string {
  const value = getEnv(name);
  if (value === undefined || value === '') {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

/** Whether CI/hermetic execution explicitly disables detached daemons. */
export function isDaemonDisabledByEnv(): boolean {
  return ['1', 'true'].includes((getEnv('BROWSER_PILOT_NO_DAEMON') ?? '').trim().toLowerCase());
}
