import { getEnv } from '../runtime/env.ts';

/** Resolve at connection time; plaintext session records store only the env name. */
export function resolveWsHeaders(bearerTokenEnv?: string): Record<string, string> | undefined {
  if (!bearerTokenEnv) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(bearerTokenEnv)) {
    throw new Error('--ws-bearer-env must name an environment variable');
  }
  const token = getEnv(bearerTokenEnv);
  if (!token)
    throw new Error(`Missing WebSocket bearer token environment variable: ${bearerTokenEnv}`);
  return { Authorization: `Bearer ${token}` };
}
