/**
 * Shell-agnostic core for driving browser-pilot from a shell command.
 *
 * Pure Web-standard APIs only: no node:*, no console, no timers, no
 * process.env. Credentials never enter this module — the trusted host's
 * SessionOwner resolves handles to WebSocket URLs per invocation, and error
 * messages are sanitized so a wsUrl can never leak to shell output.
 *
 * A thin binding for a specific shell runtime lives in a sibling adapter
 * directory and re-exports this barrel; other shell hosts can depend on
 * `browser-pilot/shell` directly.
 */

export type { BpIo } from './app.ts';
export { runBp } from './app.ts';
export { parseArgs } from './args.ts';
export { defaultConnect } from './default-connect.ts';
export { helpText } from './help.ts';
export {
  type ActionReceipt,
  type ArtifactPutResult,
  type ArtifactSink,
  CapabilityError,
  type Clock,
  type CreateSessionOptions,
  type DispatchState,
  type ExecutionContext,
  type ProviderReleaseResult,
  type SessionHandle,
  type SessionOpenOptions,
  type SessionOwner,
} from './ports.ts';
export type {
  BpBrowser,
  BpPage,
  BpPageOptions,
  BpRunResult,
  BpTargetInfo,
  BrowserPilotCapabilities,
  BrowserPilotLimits,
  BrowserPilotShellPorts,
  ConnectFn,
} from './types.ts';
export { BpError, EXIT } from './types.ts';
