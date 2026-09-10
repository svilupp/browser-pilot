// Keep the shared operation shapes in the dependency-free execution module.
// `core/ports.ts` re-exports them, but also re-exports this artifact family;
// importing directly here avoids a type import cycle in lint and API tooling.
import type { OperationContext } from '../core/execution.ts';

export type { Clock, OperationContext } from '../core/execution.ts';

/**
 * Result of a single artifact write.
 *
 * `hash` is `sha256:<hex>`. Never include credentials or raw bytes in any
 * of these fields.
 */
export type ArtifactPutResult =
  | { status: 'written'; ref: string; path: string; size: number; hash: string; type: string }
  // Dispatched but the deadline/cancellation fired before completion could be
  // observed; the destination may still change after this result is returned.
  | { status: 'write_pending_after_deadline'; ref: string; path: string; error: string }
  | { status: 'failed'; path: string; error: string; dispatched: boolean };

export interface ArtifactPutOptions {
  path: string;
  type: string;
  ctx: OperationContext;
  /** Allow overwriting an existing regular file at `path`. Default false. */
  overwrite?: boolean;
}

/** Sink port for writing artifact bytes to some destination. */
export interface ArtifactSink {
  put(bytes: Uint8Array, opts: ArtifactPutOptions): Promise<ArtifactPutResult>;
}
