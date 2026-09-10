/** Optional host integration contracts. Browser and Page do not require a ports bundle. */

import type { ExecutionContext } from './execution.ts';

export type { ArtifactPutOptions, ArtifactPutResult, ArtifactSink } from '../artifacts/types.ts';
export type { ActionReceipt, DispatchState } from '../browser/types.ts';
export type { Clock, ExecutionContext, OperationContext } from './execution.ts';

/**
 * Read-only secret access. Replaces ambient environment reads in the core.
 */
export interface SecretsPort {
  get(name: string): string | undefined;
}

/**
 * A plain, JSON-serializable reference to an open browser session.
 * Never contains credentials (no API keys, no signed transport URLs).
 */
export interface SessionHandle {
  id: string;
  generation: string;
  leaseExpiresAt?: number;
  provider: string;
  sessionId?: string;
}

/** Inputs for opening a session through a {@link SessionOwner}. */
export type SessionOpenOptions = {
  provider: 'browserbase' | 'browserless' | 'browser-use' | 'generic';
  wsUrl?: string;
  session?: import('../providers/types.ts').CreateSessionOptions;
};

/**
 * Owns provider sessions for hosts that need serializable handles.
 * Handles stay credential-free; `resolve` returns the transport locator
 * (a non-credential URL or a signed/short-lived one).
 */
export interface SessionOwner {
  open(opts: SessionOpenOptions, ctx: ExecutionContext): Promise<SessionHandle>;
  resolve(handle: SessionHandle, ctx: ExecutionContext): Promise<{ wsUrl: string }>;
  release(
    handle: SessionHandle,
    ctx: ExecutionContext
  ): Promise<import('../providers/types.ts').ProviderReleaseResult>;
  /** Optionally extend a lease; returns the refreshed handle. */
  touch?(handle: SessionHandle, ctx: ExecutionContext): Promise<SessionHandle>;
}

/**
 * Thrown when a capability required by the current code path is not available
 * in this runtime/configuration (e.g. `secrets`, `local-discovery`,
 * `stale_handle`, `recording`).
 */
export class CapabilityError extends Error {
  constructor(
    public readonly capability: string,
    message?: string
  ) {
    super(message ?? `Missing capability: ${capability}`);
    this.name = 'CapabilityError';
  }
}
