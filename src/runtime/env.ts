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

/** Read an environment variable. Returns `undefined` when missing or in Workers. */
export function getEnv(name: string): string | undefined {
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
