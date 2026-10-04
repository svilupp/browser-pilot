/**
 * browser-pilot/adapters/node — Node/Bun implementations of the core ports.
 *
 * Use these with `browser-pilot/core` (`connectCore`, `createProvider`) when
 * running on a Node-compatible runtime.
 */

import { NodeArtifactSink, type NodeArtifactSinkOptions } from '../../artifacts/node.ts';
import type { Clock, SecretsPort } from '../../core/ports.ts';
import { now } from '../../runtime/clock.ts';
import { getEnv } from '../../runtime/env.ts';
import {
  loadCookieStateFile,
  resolveCookieStateRef,
  saveCookieStateFile,
} from './cookie-state-files.ts';

export { NodeArtifactSink, type NodeArtifactSinkOptions };
export { loadCookieStateFile, resolveCookieStateRef, saveCookieStateFile };

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? 'Aborted'));
}

/** Real time source: `Date.now()`-based clock with cancellable `setTimeout` sleeps. */
export const nodeClock: Clock = {
  now,
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal ? abortReason(signal) : new Error('Aborted'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
};

/**
 * Env-backed secrets. Reads through `src/runtime/env.ts`, so `setEnvOverrides`
 * / `withEnv` injections are honored alongside `process.env`.
 */
export const nodeSecrets: SecretsPort = { get: getEnv };

export { createNodeTransportFactory } from './transport.ts';

import {
  type InProcessSessionOwnerOptions,
  InProcessSessionOwner as PortableLegacyOwner,
} from '../../core/sessions/legacy-owner.ts';
export type { InProcessSessionOwnerOptions };
/** Compatibility owner for declared reconnectable providers. Prefer ConnectionSessionOwner for held connections. */
export class InProcessSessionOwner extends PortableLegacyOwner {
  constructor(options: InProcessSessionOwnerOptions = {}) {
    super({ ...options, secrets: options.secrets ?? nodeSecrets });
  }
}

export { nodeRecordingIo } from './recording.ts';

export { ConnectionSessionOwner } from './session-owner.ts';
