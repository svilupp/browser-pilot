/**
 * Types for the browser-pilot just-bash command bridge.
 */

import type { ActionOptions, ActionReceipt, TypeOptions } from '../browser/types.ts';
import type { ArtifactSink, Clock, ExecutionContext, SessionOwner } from './ports.ts';

/** Capabilities the host policy grants to shell users. Default: read only. */
export interface BrowserPilotCapabilities {
  read: boolean;
  evaluate: boolean;
  action: boolean;
  webmcp: boolean;
}

export interface BrowserPilotLimits {
  /** Hard byte limit per output stream (default 1 MiB, minimum 32). Oversize output fails without truncation. */
  maxOutputBytes?: number;
  /** Max artifact size accepted for screenshot/download (default 10 MiB). */
  maxArtifactBytes?: number;
}

/** Page operations and WebMCP helpers used by the bridge. */
export interface BpPage {
  /** The target selected for this page connection, when exposed by the host. */
  readonly targetId?: string;
  goto(url: string, options?: ActionOptions): Promise<void>;
  url(): Promise<string>;
  title(): Promise<string>;
  text(selector?: string): Promise<string>;
  snapshot(): Promise<unknown>;
  /** Returns base64-encoded image data. */
  screenshot(options?: {
    format?: 'png' | 'jpeg' | 'webp';
    quality?: number;
    fullPage?: boolean;
  }): Promise<string>;
  evaluate(expression: string): Promise<unknown>;
  click(selector: string | string[], options?: ActionOptions): Promise<boolean>;
  type(selector: string | string[], text: string, options?: TypeOptions): Promise<boolean>;
  press(
    key: string,
    options?: { modifiers?: Array<'Control' | 'Shift' | 'Alt' | 'Meta'> }
  ): Promise<void>;
  /** The receipt recorded by the underlying Page action, when available. */
  getLastActionReceipt?(): ActionReceipt | undefined;
  /** Clear any previous action receipt before a new dispatch, when available. */
  resetLastActionReceipt?(): void;
  /** WebMCP tool discovery (wired to src/webmcp in the default connect). */
  webmcpList(fromOrigins?: string[]): Promise<unknown>;
  webmcpCall(
    name: string,
    input: unknown,
    options?: { origin?: string; allowMutation?: boolean; signal?: AbortSignal }
  ): Promise<unknown>;
}

/** Target selection passed to the host's Browser.page implementation. */
export interface BpPageOptions {
  targetId?: string;
}

export interface BpTargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

/** Minimal browser surface the bridge needs. */
export interface BpBrowser {
  page(options?: BpPageOptions): Promise<BpPage>;
  listTargets(): Promise<BpTargetInfo[]>;
  /** Disconnect only — never releases the provider session. */
  disconnect(): Promise<void>;
}

export type ConnectFn = (wsUrl: string, ctx: ExecutionContext) => Promise<BpBrowser>;

export interface BrowserPilotJustBashPorts {
  /** Required — trusted host owns credentials. */
  sessionOwner: SessionOwner;
  /** Required for screenshot/download; otherwise those commands fail with a capability error. */
  artifacts?: ArtifactSink;
  clock: Clock;
  /** Host supplies generation/deadline/signal per invocation. */
  createContext(): ExecutionContext;
  capabilities: BrowserPilotCapabilities;
  limits?: BrowserPilotLimits;
  /**
   * Browser connection factory. Defaults to the real CDP `connect()` with the
   * generic provider. Injectable so tests run without a browser.
   */
  connect?: ConnectFn;
}

/** Result contract shared with the just-bash `ExecResult` (subset). */
export interface BpRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Exit codes: 0 ok, 1 runtime, 2 usage/stale/lease, 3 capability, 124 deadline, 130 cancelled. */
export const EXIT = {
  ok: 0,
  runtime: 1,
  usage: 2,
  capability: 3,
  deadline: 124,
  cancelled: 130,
} as const;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export class BpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number = EXIT.runtime,
    readonly details: Record<string, JsonValue> = {}
  ) {
    super(message);
    this.name = 'BpError';
  }
}

export function usageError(message: string): never {
  throw new BpError('usage', message, EXIT.usage);
}
