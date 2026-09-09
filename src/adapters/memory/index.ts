/**
 * browser-pilot/adapters/memory — deterministic in-memory port implementations.
 *
 * For tests (yours and consumers'): a manually-advanced {@link FakeClock},
 * record-backed {@link MemorySecrets}, and a scripted
 * {@link MemorySessionOwner}. Fully portable — no Node APIs.
 */

import { MemoryArtifactSink, type MemoryArtifactSinkOptions } from '../../artifacts/memory.ts';
import {
  CapabilityError,
  type Clock,
  type ExecutionContext,
  type SecretsPort,
  type SessionHandle,
  type SessionOpenOptions,
  type SessionOwner,
} from '../../core/ports.ts';
import type { ProviderReleaseResult } from '../../providers/types.ts';

export { MemoryArtifactSink, type MemoryArtifactSinkOptions };

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? 'Aborted'));
}

interface Sleeper {
  due: number;
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/**
 * Manually-advanced clock. `sleep()` resolves only when `advance()`/`setTime()`
 * moves time past the due point, and rejects immediately when the given signal
 * aborts. Time never moves on its own.
 */
export class FakeClock implements Clock {
  private current: number;
  private sleepers: Sleeper[] = [];

  constructor(startMs = 0) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      if (ms <= 0) {
        resolve();
        return;
      }
      const sleeper: Sleeper = {
        due: this.current + ms,
        resolve,
        reject,
        cleanup: () => {},
      };
      if (signal) {
        const onAbort = (): void => {
          this.sleepers = this.sleepers.filter((candidate) => candidate !== sleeper);
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        sleeper.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.sleepers.push(sleeper);
    });
  }

  /** Advance time by `ms`, resolving every sleep whose due time was reached. */
  advance(ms: number): void {
    this.setTime(this.current + ms);
  }

  /** Jump to an absolute time (must not go backwards), waking due sleepers. */
  setTime(timeMs: number): void {
    if (timeMs < this.current) {
      throw new Error(`FakeClock cannot go backwards (now=${this.current}, requested=${timeMs})`);
    }
    this.current = timeMs;
    const due = this.sleepers.filter((sleeper) => sleeper.due <= timeMs);
    this.sleepers = this.sleepers.filter((sleeper) => sleeper.due > timeMs);
    for (const sleeper of due) {
      sleeper.cleanup();
      sleeper.resolve();
    }
  }

  /** Number of unresolved sleeps (test/debug use only). */
  get pendingSleeps(): number {
    return this.sleepers.length;
  }
}

/** Record-backed {@link SecretsPort} for tests: `new MemorySecrets({ KEY: 'v' })`. */
export class MemorySecrets implements SecretsPort {
  private readonly record: Record<string, string | undefined>;

  constructor(record: Record<string, string | undefined> = {}) {
    this.record = { ...record };
  }

  get(name: string): string | undefined {
    return this.record[name];
  }

  /** Mutate a secret after construction (test/debug use only). */
  set(name: string, value: string | undefined): void {
    this.record[name] = value;
  }
}

/** Scripted behaviors for {@link MemorySessionOwner}. */
export interface MemorySessionOwnerOptions {
  /** wsUrl returned by `resolve()` when the open options carry none. */
  wsUrl?: string;
  /** When set, `open()` rejects with this error. */
  openError?: Error;
  /** When set, `release()` resolves with this result instead of `released`. */
  releaseResult?: ProviderReleaseResult;
  /** Optional lease duration, measured by `clock` or the opening context clock. */
  leaseMs?: number;
  /** Clock used for lease stamps and expiry checks. */
  clock?: Clock;
  /** Optional release script for testing retry and throwing-close behavior. */
  releaseResults?: ReadonlyArray<ProviderReleaseResult | Error>;
}

/**
 * Scripted in-memory {@link SessionOwner}. Never touches the network; records
 * every call so tests can assert on interactions. Enforces the same
 * generation-fencing contract as `InProcessSessionOwner`
 * (`CapabilityError('stale_handle')`).
 */
export class MemorySessionOwner implements SessionOwner {
  readonly opened: Array<{ opts: SessionOpenOptions; handle: SessionHandle }> = [];
  readonly resolvedHandles: SessionHandle[] = [];
  readonly releasedHandles: SessionHandle[] = [];

  private readonly options: MemorySessionOwnerOptions;
  private readonly live = new Map<string, MemorySessionRecord>();
  private releaseAttempt = 0;
  private counter = 0;

  constructor(options: MemorySessionOwnerOptions = {}) {
    this.options = options;
  }

  async open(opts: SessionOpenOptions, ctx: ExecutionContext): Promise<SessionHandle> {
    assertContextActive(ctx);
    if (this.options.openError) throw this.options.openError;
    this.counter += 1;
    const id = `memory-session-${this.counter}`;
    const wsUrl = opts.wsUrl ?? this.options.wsUrl ?? `ws://memory.invalid/${id}`;
    const clock = this.options.clock ?? ctx.clock;
    const record: MemorySessionRecord = {
      wsUrl,
      generation: ctx.generation,
      provider: opts.provider,
      sessionId: id,
      clock,
      ...(this.options.leaseMs !== undefined
        ? { leaseExpiresAt: clock.now() + this.options.leaseMs }
        : {}),
    };
    this.live.set(id, record);
    const handle = this.handleForRecord(id, record);
    this.opened.push({ opts, handle });
    return handle;
  }

  private assertGeneration(
    handle: SessionHandle,
    ctx: ExecutionContext
  ): MemorySessionRecord | undefined {
    if (handle.generation !== ctx.generation) {
      throw new CapabilityError(
        'stale_handle',
        `Session handle ${handle.id} belongs to generation "${handle.generation}" but the ` +
          `current execution generation is "${ctx.generation}"`
      );
    }

    const record = this.live.get(handle.id);
    if (!record) return undefined;
    if (record.generation !== handle.generation || record.generation !== ctx.generation) {
      throw new CapabilityError(
        'stale_handle',
        `Session handle ${handle.id} does not match the generation that owns the session`
      );
    }
    return record;
  }

  private assertFresh(
    handle: SessionHandle,
    ctx: ExecutionContext
  ): MemorySessionRecord | undefined {
    const record = this.assertGeneration(handle, ctx);
    if (!record) return undefined;
    if (record.leaseExpiresAt !== undefined && record.leaseExpiresAt !== handle.leaseExpiresAt) {
      throw new CapabilityError(
        'stale_handle',
        `Session handle ${handle.id} does not match the lease issued for the session`
      );
    }
    return record;
  }

  private assertLeaseActive(handle: SessionHandle, record: MemorySessionRecord): void {
    if (record.leaseExpiresAt !== undefined && record.leaseExpiresAt <= record.clock.now()) {
      throw new CapabilityError(
        'lease_expired',
        `Session handle ${handle.id} lease expired at ${record.leaseExpiresAt}`
      );
    }
  }

  private handleForRecord(id: string, record: MemorySessionRecord): SessionHandle {
    const handle: SessionHandle = {
      id,
      generation: record.generation,
      provider: record.provider,
      sessionId: record.sessionId,
    };
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
    this.resolvedHandles.push(handle);
    return { wsUrl: record.wsUrl };
  }

  async release(handle: SessionHandle, ctx: ExecutionContext): Promise<ProviderReleaseResult> {
    // Cleanup remains available after cancellation or a deadline, just as it
    // does after lease expiry. This lets callers recover sessions at the end
    // of an aborted operation.
    // Release intentionally checks only the authoritative generation. A
    // stale or expired lease field must not strand cleanup after touch/expiry.
    const record = this.assertGeneration(handle, ctx);
    // Keep the test double's call log faithful to the SessionOwner API. A
    // repeated or concurrent call is recorded even when it reuses an
    // in-flight cleanup attempt or observes an already-released record.
    this.releasedHandles.push(handle);
    if (!record) {
      return { status: 'already_released', sessionId: handle.sessionId ?? handle.id };
    }

    // Release remains available after lease expiry. Only resolve/touch are
    // lease-gated; cleanup must be able to recover an expired session.
    if (record.releasePromise) return record.releasePromise;

    const sessionId = record.sessionId;
    const attempt = Promise.resolve().then(() => this.nextReleaseResult(sessionId));
    const tracked = attempt.then(
      (result) => {
        if (result.status === 'released' || result.status === 'already_released') {
          if (this.live.get(handle.id) === record) this.live.delete(handle.id);
        } else {
          record.releasePromise = undefined;
        }
        return result;
      },
      (error: unknown) => {
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
    return this.live.size;
  }

  private nextReleaseResult(sessionId: string): ProviderReleaseResult {
    const scripted = this.options.releaseResults?.[this.releaseAttempt];
    this.releaseAttempt += 1;
    if (scripted instanceof Error) throw scripted;
    return scripted ?? this.options.releaseResult ?? { status: 'released', sessionId };
  }
}

interface MemorySessionRecord {
  wsUrl: string;
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

/** Convenience {@link ExecutionContext} builder for tests. */
export function createTestContext(
  overrides: Partial<ExecutionContext> & { clock?: Clock } = {}
): ExecutionContext {
  return {
    signal: overrides.signal ?? new AbortController().signal,
    generation: overrides.generation ?? 'test-generation',
    clock: overrides.clock ?? new FakeClock(),
    ...(overrides.deadline !== undefined ? { deadline: overrides.deadline } : {}),
  };
}
