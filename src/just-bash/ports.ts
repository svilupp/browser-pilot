/**
 * Port contracts used by the just-bash bridge.
 *
 * These are the hexagonal core contracts from `src/core/ports.ts` (and the
 * artifact port from `src/artifacts/types.ts`), re-exported so every module
 * under `src/just-bash/` has a single local import site.
 */

export type { ArtifactPutResult, ArtifactSink } from '../artifacts/types.ts';
// Browser actions already expose this receipt contract. Keep the shell bridge
// on that same vocabulary instead of introducing a second effect enum.
export type { ActionReceipt, DispatchState } from '../browser/types.ts';
export {
  CapabilityError,
  type Clock,
  type ExecutionContext,
  type SessionHandle,
  type SessionOpenOptions,
  type SessionOwner,
} from '../core/ports.ts';
export type { CreateSessionOptions, ProviderReleaseResult } from '../providers/types.ts';
