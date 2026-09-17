/**
 * browser-pilot/adapters/node — Node/Bun implementations of the core ports.
 *
 * Use these with `browser-pilot/core` (`connectCore`, `createProvider`) when
 * running on a Node-compatible runtime.
 */

import { NodeArtifactSink, type NodeArtifactSinkOptions } from '../../artifacts/node.ts';
import {
  CapabilityError,
  type Clock,
  type ExecutionContext,
  type SecretsPort,
  type SessionHandle,
  type SessionOpenOptions,
  type SessionOwner,
} from '../../core/ports.ts';
import { createProvider } from '../../providers/factory.ts';
import type { ProviderReleaseResult, ProviderSession } from '../../providers/types.ts';
import { now } from '../../runtime/clock.ts';
import { getEnv } from '../../runtime/env.ts';
import { randomId } from '../../runtime/id.ts';
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

/** Options for {@link InProcessSessionOwner}. */
export interface InProcessSessionOwnerOptions {
  /** Secrets used for provider API-key resolution (default: {@link nodeSecrets}). */
  secrets?: SecretsPort;
  /** Trusted host endpoint used when opening generic sessions without an explicit wsUrl. */
  genericWsUrl?: string;
  /** When set, handles carry an authoritative `leaseExpiresAt = now + leaseMs`. */
  leaseMs?: number;
  /** Clock used for lease stamps (default: {@link nodeClock}). */
  clock?: Clock;
}

/**
 * In-process {@link SessionOwner}: creates provider sessions via the portable
 * `createProvider` factory and keeps the credential-bearing `ProviderSession`
 * objects in a private Map. Returned {@link SessionHandle}s are plain JSON
 * data — no API keys and no transport URLs. `resolve()` returns the provider
 * session's wsUrl; `release()` closes the session and reports the provider's
 * release result. Handles from a different `ctx.generation` are rejected with
 * `CapabilityError('stale_handle')`.
 * Browserbase sessions require keepAlive (enabled automatically). Browserless
 * launch URLs are rejected because this owner cannot reconnect to them.
 */
export class InProcessSessionOwner implements SessionOwner {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly options: InProcessSessionOwnerOptions;

  constructor(options: InProcessSessionOwnerOptions = {}) {
    this.options = options;
  }

  async open(opts: SessionOpenOptions, ctx: ExecutionContext): Promise<SessionHandle> {
    assertContextActive(ctx);
    if (opts.provider === 'browserless') {
      throw new CapabilityError(
        'session-reconnect',
        'InProcessSessionOwner cannot reconnect Browserless launch URLs. Use a custom SessionOwner that manages Browserless reconnection, or use the direct browser library.'
      );
    }
    if (
      opts.provider === 'browserbase' &&
      opts.session?.['keepAlive'] !== undefined &&
      opts.session['keepAlive'] !== true
    ) {
      throw new CapabilityError(
        'session-reconnect',
        'InProcessSessionOwner requires Browserbase keepAlive: true so sessions survive command disconnects.'
      );
    }
    const sessionOptions =
      opts.provider === 'browserbase' ? { ...opts.session, keepAlive: true } : opts.session;
    const wsUrl =
      opts.wsUrl ?? (opts.provider === 'generic' ? this.options.genericWsUrl : undefined);
    if (opts.provider === 'generic' && !wsUrl) {
      throw new CapabilityError(
        'generic-endpoint',
        'Generic sessions require the host to configure genericWsUrl or pass wsUrl when opening the session.'
      );
    }
    const provider = createProvider(
      { provider: opts.provider, wsUrl, session: sessionOptions },
      { secrets: this.options.secrets ?? nodeSecrets }
    );
    const session = await provider.createSession(sessionOptions);
    try {
      assertContextActive(ctx);
    } catch (error) {
      // The context aborted or expired while createSession() was in flight.
      // createSession() itself is not abortable, so the just-created
      // provider session must be released best-effort here rather than
      // stored or handed back to the caller.
      await Promise.resolve()
        .then(() => session.close())
        .catch(() => {});
      throw error;
    }
    const id = `bp-session-${randomId()}`;
    // Pin the clock used for this record's lease at open time, matching the
    // memory adapter's semantics: prefer the explicit option, then the
    // opening context's clock (not a fixed `nodeClock` default).
    const clock = this.options.clock ?? ctx.clock;
    const record: SessionRecord = {
      session,
      generation: ctx.generation,
      provider: opts.provider,
      sessionId: session.sessionId ?? id,
      clock,
      ...(this.options.leaseMs !== undefined
        ? { leaseExpiresAt: clock.now() + this.options.leaseMs }
        : {}),
    };
    this.sessions.set(id, record);
    return this.handleForRecord(id, record);
  }

  private assertGeneration(
    handle: SessionHandle,
    ctx: ExecutionContext
  ): SessionRecord | undefined {
    if (handle.generation !== ctx.generation) {
      throw new CapabilityError(
        'stale_handle',
        `Session handle ${handle.id} belongs to generation "${handle.generation}" but the ` +
          `current execution generation is "${ctx.generation}"`
      );
    }

    const record = this.sessions.get(handle.id);
    if (!record) return undefined;

    // The generation in a JSON handle is untrusted input. Compare it with
    // the generation captured when the provider session was opened, rather
    // than trusting a caller that rewrites the serialized handle.
    if (record.generation !== handle.generation || record.generation !== ctx.generation) {
      throw new CapabilityError(
        'stale_handle',
        `Session handle ${handle.id} does not match the generation that owns the session`
      );
    }

    return record;
  }

  private assertFresh(handle: SessionHandle, ctx: ExecutionContext): SessionRecord | undefined {
    const record = this.assertGeneration(handle, ctx);
    if (!record) return undefined;

    // Keep the lease metadata fenced for resolve/touch. A caller cannot
    // extend a lease by editing or removing its expiry field in JSON.
    if (record.leaseExpiresAt !== undefined && record.leaseExpiresAt !== handle.leaseExpiresAt) {
      throw new CapabilityError(
        'stale_handle',
        `Session handle ${handle.id} does not match the lease issued for the session`
      );
    }

    return record;
  }

  private assertLeaseActive(handle: SessionHandle, record: SessionRecord): void {
    if (record.leaseExpiresAt !== undefined && record.leaseExpiresAt <= record.clock.now()) {
      throw new CapabilityError(
        'lease_expired',
        `Session handle ${handle.id} lease expired at ${record.leaseExpiresAt}`
      );
    }
  }

  private handleForRecord(id: string, record: SessionRecord): SessionHandle {
    const handle: SessionHandle = {
      id,
      generation: record.generation,
      provider: record.provider,
    };
    if (record.session.sessionId !== undefined) handle.sessionId = record.session.sessionId;
    if (record.leaseExpiresAt !== undefined) handle.leaseExpiresAt = record.leaseExpiresAt;
    return handle;
  }

  async resolve(handle: SessionHandle, ctx: ExecutionContext): Promise<{ wsUrl: string }> {
    assertContextActive(ctx);
    const record = this.assertFresh(handle, ctx);
    if (!record) {
      throw new CapabilityError(
        'stale_handle',
        `Unknown or already-released session handle ${handle.id}`
      );
    }
    this.assertLeaseActive(handle, record);
    return { wsUrl: record.session.wsUrl };
  }

  async release(handle: SessionHandle, ctx: ExecutionContext): Promise<ProviderReleaseResult> {
    // Cleanup is best-effort and remains available after cancellation or a
    // deadline. The provider release operation has its own bounded budget;
    // refusing it here would strand sessions when the owning operation ends.
    // Release intentionally checks only the authoritative generation. A
    // stale or expired lease field must not strand cleanup after touch/expiry.
    const record = this.assertGeneration(handle, ctx);
    if (!record) {
      return { status: 'already_released', sessionId: handle.sessionId ?? handle.id };
    }

    // Release is deliberately allowed after lease expiry so an expired
    // capability can still clean up the provider session.
    if (record.releasePromise) return record.releasePromise;

    const sessionId = record.sessionId;
    const attempt = Promise.resolve()
      .then(() => record.session.close())
      .then((result): ProviderReleaseResult => result ?? { status: 'released', sessionId });
    const tracked = attempt.then(
      (result) => {
        if (result.status === 'released' || result.status === 'already_released') {
          // Keep the record until the provider has confirmed a terminal
          // result. Pending cleanup remains addressable for a later retry.
          if (this.sessions.get(handle.id) === record) this.sessions.delete(handle.id);
        } else {
          record.releasePromise = undefined;
        }
        return result;
      },
      (error: unknown) => {
        // A throwing close is retryable too; leave the session record in the
        // map and clear only the in-flight marker.
        record.releasePromise = undefined;
        throw error;
      }
    );
    record.releasePromise = tracked;
    return tracked;
  }

  async touch(handle: SessionHandle, ctx: ExecutionContext): Promise<SessionHandle> {
    assertContextActive(ctx);
    const record = this.assertFresh(handle, ctx);
    if (!record) {
      throw new CapabilityError(
        'stale_handle',
        `Unknown or already-released session handle ${handle.id}`
      );
    }
    this.assertLeaseActive(handle, record);
    if (this.options.leaseMs !== undefined) {
      record.leaseExpiresAt = record.clock.now() + this.options.leaseMs;
    }
    return this.handleForRecord(handle.id, record);
  }

  /** Number of sessions currently owned (test/debug use only). */
  get size(): number {
    return this.sessions.size;
  }
}

interface SessionRecord {
  session: ProviderSession;
  generation: string;
  provider: string;
  sessionId: string;
  clock: Clock;
  leaseExpiresAt?: number;
  releasePromise?: Promise<ProviderReleaseResult>;
}

function assertContextActive(ctx: ExecutionContext): void {
  if (ctx.signal.aborted) throw abortReason(ctx.signal);
  if (ctx.deadline !== undefined && ctx.clock.now() >= ctx.deadline) {
    throw new CapabilityError('deadline', 'Execution deadline exceeded before session operation');
  }
}
