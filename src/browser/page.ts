/**
 * Page class - provides high-level browser automation API
 */

import { BatchExecutor, type BatchOptions, type BatchResult, type Step } from '../actions/index.ts';
import { AudioInput } from '../audio/input.ts';
import { AudioOutput } from '../audio/output.ts';
import type { CaptureResult, RoundTripOptions, RoundTripResult } from '../audio/types.ts';
import type { CDPClient } from '../cdp/client.ts';
import type { BoxModel, ExceptionDetails, RemoteObject } from '../cdp/protocol.ts';
import type { DeviceDescriptor } from '../emulation/index.ts';
import {
  type RequestHandler,
  RequestInterceptor,
  type RequestPattern,
  type ResourceType,
  type RouteOptions,
} from '../network/index.ts';
import type { ActionTargetMetadata } from '../recording/redaction.ts';
import type {
  ClearCookiesOptions,
  Cookie,
  DeleteCookieOptions,
  SetCookieOptions,
} from '../storage/types.ts';
import { stringifyUnknown } from '../utils/json.ts';
import {
  DEEP_QUERY_SCRIPT,
  FOCUSABLE_INPUT_PREDICATE_SCRIPT,
  VISIBLE_PREDICATE_SCRIPT,
  VISIBLE_REASON_PREDICATE_SCRIPT,
  waitForAnyElement,
  waitForNetworkIdle as waitForIdle,
  waitForNavigation as waitForNav,
  waitForReady as waitForReadyStrategy,
} from '../wait/index.ts';
import { ActionDispatch } from './action-dispatch.ts';
import { ActionabilityError, ensureActionable } from './actionability.ts';
import { computeDelta, type DeltaResult, extractPageState, type PageState } from './delta.ts';
import { type DiagnoseOptions, type DiagnoseResult, diagnoseElement } from './diagnose.ts';
import {
  type EmitRealm,
  type EmitResult,
  type EmitWsOptions,
  emitWsMessage,
  listSockets,
  type SocketCandidate,
} from './emit.ts';
import { fillValuesMatchNormalized } from './fill-normalize.ts';
import { buildFingerprintMap, fingerprintSimilarity, recoverStaleRef } from './fingerprint.ts';
import { generateHints } from './hint-generator.ts';
import {
  computeModifierBitmask,
  type KeyDefinition,
  MODIFIER_CODES,
  MODIFIER_KEY_CODES,
  type ModifierKey,
  parseShortcut,
  US_KEYBOARD,
} from './keyboard.ts';
import { extractReview, type ReviewResult } from './review.ts';
import { type CandidateStrategy, type RankedCandidate, rankCandidates } from './selector-rank.ts';
import { buildSpecialSelectorLookupExpression } from './special-selectors.ts';
import { classifyStaleError, type StaleRecoveryDiagnostics } from './stale-errors.ts';
import {
  type ActionOptions,
  type ActionReceipt,
  type ConsoleHandler,
  type ConsoleMessage,
  type ConsoleMessageType,
  type CustomSelectConfig,
  type Dialog,
  type DialogHandler,
  type DialogType,
  type Download,
  type ElementInfo,
  ElementNotFoundError,
  type ElementState,
  type EmulationState,
  type ErrorHandler,
  type FileInput,
  type FillOptions,
  type FormField,
  type GeolocationOptions,
  type InteractiveElement,
  type NavigationMilestone,
  type NetworkIdleOptions,
  type PageError,
  type PageSnapshot,
  type ReadinessDiagnostics,
  type SnapshotNode,
  type SnapshotOptions,
  type SubmitOptions,
  type TargetProvenance,
  TimeoutError,
  type TypeOptions,
  type UserAgentOptions,
  type ViewportOptions,
  type WaitForOptions,
  type WaitForReadyOptions,
} from './types.ts';

const DEFAULT_TIMEOUT = 30000;

/**
 * Floor (in ms) for how long an OOPIF `switchToFrame` waits for the child
 * debugging session to auto-attach / for the child document to become ready.
 * The caller's `timeout` is honoured (M4) — this only guarantees a reasonable
 * minimum window when a very short timeout is passed, since auto-attach is
 * asynchronous and can arrive slightly after the parent DOM exposes the iframe.
 */
const OOPIF_ATTACH_MIN_TIMEOUT_MS = 5000;

function normalizeAXCheckedValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }

  return undefined;
}

/**
 * Minimal shape of a node in the flattened tree returned by CDP
 * `DOM.getDocument({ depth: -1, pierce: true })`.
 *
 * Only the fields the attribute-enrichment pass needs are modeled; this is
 * structurally compatible with the richer `DOMNode` from `../cdp/protocol.ts`,
 * so the real CDP payload assigns cleanly. `attributes` is CDP's flat
 * `[name, value, name, value, ...]` list.
 */
export interface FlatDomNode {
  backendNodeId?: number;
  nodeName?: string;
  attributes?: string[];
  children?: FlatDomNode[];
  contentDocument?: FlatDomNode;
  shadowRoots?: FlatDomNode[];
}

/**
 * Result of resolving an <iframe>/<frame> element: its `frameId` (if any) and
 * the same-session `contentDocument` nodeId. `contentNodeId` is `undefined` for
 * a cross-origin (OOPIF) frame whose document is unreachable from this session.
 */
interface ReturnFrameDescribe {
  frameId?: string;
  contentNodeId?: number;
}

/**
 * Heuristic: is `c` a durable, semantic class name worth handing to the ranker?
 *
 * Rejects generated/hashed/atomic tokens that change between builds or renders
 * (CSS-modules hashes, styled-components/emotion suffixes, atomic gibberish,
 * purely-numeric and over-long tokens) and keeps short human-authored names.
 */
export function isStableClassName(c: string): boolean {
  const cls = c.trim();
  if (cls.length === 0) return false;

  // Over-long tokens are almost always generated/atomic.
  if (cls.length > 24) return false;

  // Purely-numeric tokens carry no semantic meaning.
  if (/^\d+$/.test(cls)) return false;

  // CSS-modules hashes: a semantic prefix glued to a hash via `_`/`__` where the
  // tail contains a digit, e.g. `Button_abc123`, `Header__3xY7z`.
  if (/_{1,2}[a-z0-9]*\d[a-z0-9]*$/i.test(cls)) return false;

  // Hashed/atomic suffixes: `<prefix>-<6+ char hashy tail>` where the tail looks
  // random (has a digit, or mixes letter case), e.g. `css-1a2b3c`, `sc-bdVaJa`.
  // Plain semantic tails like `nav-container` are kept.
  const dash = cls.indexOf('-');
  if (dash > 0) {
    const tail = cls.slice(dash + 1);
    if (
      tail.length >= 6 &&
      /^[a-z0-9]+$/i.test(tail) &&
      (/\d/.test(tail) || (/[a-z]/.test(tail) && /[A-Z]/.test(tail)))
    ) {
      return false;
    }
  }

  // Separator-free alphanumeric gibberish with digits (atomic classes, e.g. `x1nrf0dw`).
  if (cls.length >= 6 && !/[-_]/.test(cls) && /\d/.test(cls) && /[a-z]/i.test(cls)) {
    return false;
  }

  return true;
}

/**
 * Pure extraction pass over a flattened CDP DOM tree.
 *
 * Walks the tree (including iframe `contentDocument` and `shadowRoots`) and
 * returns a `backendNodeId -> attributes` map. Attribute names in `wantedNames`
 * are copied verbatim; `class` is filtered down to stable tokens only. Nodes
 * with no relevant attributes are omitted. No browser required — fully testable.
 */
export function extractAttributesByBackendId(
  root: FlatDomNode | undefined,
  wantedNames: readonly string[]
): Map<number, Record<string, string>> {
  const wanted = new Set(wantedNames);
  const byBackendId = new Map<number, Record<string, string>>();

  const visit = (node: FlatDomNode | undefined): void => {
    if (!node) return;
    if (node.backendNodeId !== undefined && Array.isArray(node.attributes)) {
      const attrs: Record<string, string> = {};
      for (let i = 0; i < node.attributes.length; i += 2) {
        const name = node.attributes[i];
        const value = node.attributes[i + 1];
        if (name === undefined || value === undefined) continue;
        if (wanted.has(name)) {
          attrs[name] = value;
        } else if (name === 'class' && value.trim().length > 0) {
          // Keep stable (non-utility-noise) classes only: drop tokens that
          // look state/hash-like so the ranker gets durable hooks.
          const stable = value.split(/\s+/).filter((c) => c.length > 0 && isStableClassName(c));
          if (stable.length > 0) attrs['class'] = stable.join(' ');
        }
      }
      if (Object.keys(attrs).length > 0) byBackendId.set(node.backendNodeId, attrs);
    }
    if (node.children) for (const child of node.children) visit(child);
    if (node.contentDocument) visit(node.contentDocument);
    if (node.shadowRoots) for (const sr of node.shadowRoots) visit(sr);
  };

  visit(root);
  return byBackendId;
}

/**
 * Overrides `window.print` with a no-op that logs, so a stray click on a native
 * "Print" control cannot open the browser's print preview (which blocks the
 * renderer and stalls every subsequent CDP call). Installed per-document when
 * {@link PageOptions.blockNativePrint} is enabled.
 */
const BLOCK_NATIVE_PRINT_SCRIPT = `(() => {
  try {
    if (globalThis.__bpNativePrintBlocked) return;
    Object.defineProperty(globalThis, '__bpNativePrintBlocked', {
      value: true,
      configurable: true,
    });
    window.print = function () {
      console.warn('[browser-pilot] window.print() blocked (blockNativePrint enabled)');
    };
  } catch (e) {
    // Best-effort; never throw during page init.
  }
})();`;

const EVENT_LISTENER_TRACKER_SCRIPT = `(() => {
  if (globalThis.__bpEventListenerTrackerInstalled) return;
  Object.defineProperty(globalThis, '__bpEventListenerTrackerInstalled', {
    value: true,
    configurable: true,
  });

  const storeKey = '__bpEventListeners';
  const originalAddEventListener = EventTarget.prototype.addEventListener;
  const originalRemoveEventListener = EventTarget.prototype.removeEventListener;

  function ensureStore(target) {
    if (!Object.prototype.hasOwnProperty.call(target, storeKey)) {
      Object.defineProperty(target, storeKey, {
        value: Object.create(null),
        configurable: true,
      });
    }
    return target[storeKey];
  }

  EventTarget.prototype.addEventListener = function(type, listener, options) {
    try {
      if (listener) {
        const store = ensureStore(this);
        const bucket = store[type] || (store[type] = []);
        const capture =
          typeof options === 'boolean' ? options : !!(options && options.capture);
        const exists = bucket.some((entry) => entry.listener === listener && entry.capture === capture);
        if (!exists) {
          bucket.push({ listener, capture });
        }
      }
    } catch {}

    return originalAddEventListener.call(this, type, listener, options);
  };

  EventTarget.prototype.removeEventListener = function(type, listener, options) {
    try {
      const store = this[storeKey];
      const bucket = store && store[type];
      const capture =
        typeof options === 'boolean' ? options : !!(options && options.capture);
      if (Array.isArray(bucket)) {
        store[type] = bucket.filter((entry) => {
          return !(entry.listener === listener && entry.capture === capture);
        });
      }
    } catch {}

    return originalRemoveEventListener.call(this, type, listener, options);
  };
})();`;

/**
 * Construction-time options for a {@link Page}. Distinct from per-action options;
 * these configure behaviour installed once at {@link Page.init}.
 */
export interface PageInitOptions {
  /**
   * Override `window.print` with a logging no-op on every document, preventing a
   * stray click on a "Print" control from freezing the renderer in a native
   * print preview. Off by default. Surfaced via `PageOptions.blockNativePrint`.
   */
  blockNativePrint?: boolean;

  /** Provenance for diagnostics and workflow evidence. */
  targetProvenance?: TargetProvenance;
}

export class Page {
  private cdp: CDPClient;
  private _targetId: string;
  private rootNodeId: number | null = null;
  private batchExecutor: BatchExecutor;
  private emulationState: EmulationState = {};
  private interceptor: RequestInterceptor | null = null;
  private consoleHandlers = new Set<ConsoleHandler>();
  private errorHandlers = new Set<ErrorHandler>();
  private dialogHandler: DialogHandler | null = null;
  private consoleEnabled = false;
  /** Map of ref (e.g., "e4") to backendNodeId for ref-based selectors */
  private refMap: Map<string, number> = new Map();
  /** Current frame context (null = main frame) */
  private currentFrame: string | null = null;
  /** Stored frame document node IDs for context switching */
  private frameContexts: Map<string, number> = new Map();
  /** Map of frameId → executionContextId for JS evaluation in frames */
  private frameExecutionContexts: Map<string, number> = new Map();
  /** Current frame's execution context ID (null = main frame default) */
  private currentFrameContextId: number | null = null;
  /** Frame selector if context acquisition failed (cross-origin/sandboxed) */
  private brokenFrame: string | null = null;
  /**
   * Cross-origin (OOPIF) support. When an out-of-process iframe is the active
   * frame, `currentFrameSession` holds its flat CDP child-session id and all
   * DOM/Runtime/Input commands for that frame are routed to that session.
   * `null` = the active frame lives in this page's own (default) session, i.e.
   * top-level or a same-origin iframe — behaviour is unchanged in that case.
   */
  private currentFrameSession: string | null = null;
  /**
   * Fix #2: nodeId of the query ROOT to use within `currentFrameSession`, when
   * the active frame is a SAME-ORIGIN iframe nested INSIDE an OOPIF (e.g. a
   * real Stripe-Elements-style controller frame that itself embeds the card
   * field form, both same-origin with each other but the controller is
   * cross-origin from the top page). `null` = use the child session's own
   * top-level document as the query root (the common, non-nested case).
   * Cleared by `switchToMain`/`resetFrameState`/`dropOopifSession`.
   */
  private oopifFrameRootNodeId: number | null = null;
  /**
   * Fix #2: frameId of the same-origin nested iframe currently rooted onto
   * (`oopifFrameRootNodeId`), if any. Used by `evaluate()` to look up that
   * frame's OWN execution context in `oopifFrameExecutionContexts` instead of
   * evaluating in the OOPIF's top document. `null` = not nested / use the
   * child session's default context (unchanged behaviour).
   */
  private oopifFrameRootFrameId: string | null = null;
  /**
   * frameId → execution contextId for contexts created WITHIN an OOPIF child
   * session (fix #2). Populated per attached iframe child session in
   * `handleTargetAttached` via `onSessionEvent`, since these events carry the
   * child session's own sessionId (not delivered to the page's pinned `on()`).
   */
  private oopifFrameExecutionContexts = new Map<string, number>();
  /**
   * Registry of attached OOPIF child sessions, keyed by targetId. For an OOPIF
   * the target's `targetId` equals the iframe element's `frameId`, so this is
   * also the frameId→session map used by `switchToFrame`. Populated by the
   * `Target.attachedToTarget` auto-attach handler; entries are validated against
   * the live-session set before use (stale ones are dropped).
   */
  private oopifFrames = new Map<string, { sessionId: string; targetId: string; url: string }>();
  /**
   * Per-child-session unsubscribers for the `onSessionEvent(sessionId,
   * 'Runtime.executionContextCreated', ...)` handler registered in
   * {@link handleTargetAttached}. Without storing these, every OOPIF child
   * session attached over the page's lifetime would leak its listener on the
   * shared connection forever. Also doubles as the "already registered for
   * this session" guard, since `handleTargetAttached` can run for the same
   * sessionId from both the live `Target.attachedToTarget` event AND the
   * daemon-gap reconciliation path ({@link reconcileExistingOopifTargets}).
   */
  private oopifSessionUnsubscribers = new Map<string, () => void>();
  /** Worker targetId → flat session id, so emit reuses sessions instead of re-attaching. */
  private workerEmitSessions = new Map<string, string>();
  /** Guards against wiring OOPIF auto-attach more than once. */
  private oopifAutoAttachInstalled = false;
  /**
   * Firehose handler wired in {@link init} for `Target.attachedToTarget` /
   * `Target.detachedFromTarget`. Stored so {@link dispose} can unsubscribe it:
   * `onAny` is connection-global, so a discarded Page would otherwise keep
   * processing every attach/detach on the connection forever (listener leak).
   */
  private oopifAnyHandler:
    | ((method: string, params: Record<string, unknown>, sessionId?: string) => void)
    | null = null;
  /** True once {@link dispose} has run; makes teardown idempotent. */
  private disposed = false;
  /** Last matched selector from findElement (for selectorUsed tracking) */
  private _lastMatchedSelector: string | undefined;
  private _lastActionCoordinates: { x: number; y: number } | null = null;
  private _lastActionBoundingBox: { x: number; y: number; width: number; height: number } | null =
    null;
  private _lastActionTargetMetadata: ActionTargetMetadata | null = null;
  private _lastActionReceipt: ActionReceipt | undefined;
  private _lastNavigationMilestone: NavigationMilestone | undefined;
  private _lastReadinessDiagnostics: ReadinessDiagnostics | undefined;
  private _lastStaleRecovery: StaleRecoveryDiagnostics | undefined;
  /** Last snapshot for stale ref recovery */
  private lastSnapshot?: PageSnapshot;
  /** Audio input controller (lazy-initialized) */
  private _audioInput?: AudioInput;
  /** Audio output controller (lazy-initialized) */
  private _audioOutput?: AudioOutput;

  /**
   * When true, `window.print` is overridden to a no-op (with a console log) on
   * every document, so an AI-guessed click on a "Print" control can't freeze the
   * renderer in a native print preview (which would stall every subsequent CDP
   * call). Opt-in via {@link PageOptions.blockNativePrint}.
   */
  private readonly blockNativePrint: boolean;

  private readonly targetProvenance: TargetProvenance;

  constructor(cdp: CDPClient, targetId: string, options: PageInitOptions = {}) {
    this.cdp = cdp;
    this._targetId = targetId;
    this.blockNativePrint = options.blockNativePrint === true;
    this.targetProvenance = options.targetProvenance ?? { targetId, source: 'session' };
    this.batchExecutor = new BatchExecutor(this);
  }

  /**
   * Get the CDP target ID for this page
   */
  get targetId(): string {
    return this._targetId;
  }

  getTargetProvenance(): TargetProvenance {
    return { ...this.targetProvenance };
  }

  /**
   * Get the underlying CDP client for advanced operations.
   * Use with caution - prefer high-level Page methods when possible.
   */
  get cdpClient(): CDPClient {
    return this.cdp;
  }

  /**
   * Get the last matched selector from findElement (for selectorUsed tracking).
   * Returns undefined if no selector has been matched yet.
   */
  getLastMatchedSelector(): string | undefined {
    return this._lastMatchedSelector;
  }

  private async getActionTargetMetadata(identifiers: {
    nodeId?: number;
    objectId?: string;
  }): Promise<ActionTargetMetadata | null> {
    try {
      const objectId =
        identifiers.objectId ??
        (identifiers.nodeId ? await this.resolveObjectId(identifiers.nodeId) : undefined);
      if (!objectId) return null;
      const response = await this.cdp.send<{
        result: { value?: ActionTargetMetadata };
      }>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
          const tagName = this.tagName?.toLowerCase?.() || '';
          const inputType =
            tagName === 'input' && typeof this.type === 'string' ? this.type.toLowerCase() : '';
          const autocomplete =
            typeof this.autocomplete === 'string' ? this.autocomplete.toLowerCase() : '';
          return { tagName, inputType, autocomplete };
        }`,
        returnByValue: true,
      });
      return response.result.value ?? null;
    } catch {
      return null;
    }
  }

  private async getElementPosition(identifiers: { nodeId?: number; objectId?: string }): Promise<{
    center: { x: number; y: number };
    bbox: { x: number; y: number; width: number; height: number };
  } | null> {
    try {
      const { quads } = await this.cdp.send<{ quads: number[][] }>(
        'DOM.getContentQuads',
        identifiers
      );
      if (quads?.length > 0) {
        const q = quads[0]!;
        const minX = Math.min(q[0]!, q[2]!, q[4]!, q[6]!);
        const maxX = Math.max(q[0]!, q[2]!, q[4]!, q[6]!);
        const minY = Math.min(q[1]!, q[3]!, q[5]!, q[7]!);
        const maxY = Math.max(q[1]!, q[3]!, q[5]!, q[7]!);
        return {
          center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
          bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
        };
      }
    } catch {
      /* fallthrough to box model */
    }

    if (identifiers.nodeId) {
      const box = await this.getBoxModel(identifiers.nodeId);
      if (box) {
        return {
          center: { x: box.content[0]! + box.width / 2, y: box.content[1]! + box.height / 2 },
          bbox: { x: box.content[0]!, y: box.content[1]!, width: box.width, height: box.height },
        };
      }
    }
    return null;
  }

  private setLastActionPosition(
    coords: { x: number; y: number },
    bbox: { x: number; y: number; width: number; height: number }
  ): void {
    this._lastActionCoordinates = coords;
    this._lastActionBoundingBox = bbox;
  }

  getLastActionCoordinates(): { x: number; y: number } | null {
    return this._lastActionCoordinates;
  }

  getLastActionBoundingBox(): { x: number; y: number; width: number; height: number } | null {
    return this._lastActionBoundingBox;
  }

  getLastActionTargetMetadata(): ActionTargetMetadata | null {
    return this._lastActionTargetMetadata;
  }

  getLastActionReceipt(): ActionReceipt | undefined {
    return this._lastActionReceipt;
  }

  getLastStaleRecovery(): StaleRecoveryDiagnostics | undefined {
    return this._lastStaleRecovery;
  }

  /** Last correlated main-frame navigation milestone observed by this page. */
  getLastNavigationMilestone(): NavigationMilestone | undefined {
    return this._lastNavigationMilestone;
  }

  /** Diagnostics from the most recent semantic readiness wait. */
  getReadinessDiagnostics(): ReadinessDiagnostics | undefined {
    return this._lastReadinessDiagnostics
      ? {
          ...this._lastReadinessDiagnostics,
          unmetConditions: [...this._lastReadinessDiagnostics.unmetConditions],
        }
      : undefined;
  }

  /** Alias for inspection clients that expose diagnostics as a verb. */
  diagnoseReadiness(): ReadinessDiagnostics | undefined {
    return this.getReadinessDiagnostics();
  }

  markLastActionNavigationObserved(): void {
    if (this._lastActionReceipt) {
      this._lastActionReceipt = { ...this._lastActionReceipt, navigationObserved: true };
    }
  }

  /** Reset position tracking (call before each executor step) */
  resetLastActionPosition(): void {
    this._lastActionCoordinates = null;
    this._lastActionBoundingBox = null;
    this._lastActionTargetMetadata = null;
  }

  resetLastActionReceipt(): void {
    this._lastActionReceipt = undefined;
    this._lastStaleRecovery = undefined;
  }

  private async withActionDispatch<T>(fn: (dispatch: ActionDispatch) => Promise<T>): Promise<T> {
    const dispatch = new ActionDispatch();
    try {
      return await fn(dispatch);
    } finally {
      this._lastActionReceipt = {
        ...dispatch.toReceipt(),
        ...(this._lastStaleRecovery ? { staleRecovery: this._lastStaleRecovery } : {}),
      };
    }
  }

  /**
   * Initialize the page (enable required CDP domains)
   */
  async init(): Promise<void> {
    // Listen for execution contexts to track iframe contexts
    this.cdp.on('Runtime.executionContextCreated', (params) => {
      const context = params['context'] as {
        id: number;
        auxData?: { frameId?: string; isDefault?: boolean };
      };
      if (context.auxData?.frameId && context.auxData?.isDefault) {
        this.frameExecutionContexts.set(context.auxData.frameId, context.id);
      }
    });

    // Clean up destroyed contexts
    this.cdp.on('Runtime.executionContextDestroyed', (params) => {
      const contextId = params['executionContextId'] as number;
      for (const [frameId, ctxId] of this.frameExecutionContexts.entries()) {
        if (ctxId === contextId) {
          this.frameExecutionContexts.delete(frameId);
          // Invalidate cached frame context so next action re-resolves it
          if (this.currentFrameContextId === contextId) {
            this.currentFrameContextId = null;
          }
          break;
        }
      }
    });

    // Always listen for dialogs to prevent blocking - auto-dismiss by default
    this.cdp.on('Page.javascriptDialogOpening', (params) => {
      void this.handleDialogOpening(params);
    });

    await Promise.all([
      this.cdp.send('Page.enable'),
      this.cdp.send('DOM.enable'),
      this.cdp.send('Runtime.enable'),
      this.cdp.send('Network.enable'),
      // Emit Page.lifecycleEvent (incl. 'networkIdle') so waitForNavigation can
      // settle heavy SPAs that never fire Page.loadEventFired.
      this.cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }),
    ]);

    // Cross-origin (OOPIF) support: subscribe to target attaches and enable flat
    // auto-attach on THIS page session BEFORE any navigation, so out-of-process
    // iframes created by later navigations attach as child sessions we can drive.
    if (!this.oopifAutoAttachInstalled) {
      // Distinguish "mock/legacy client without OOPIF plumbing" (unit tests use
      // a partial CDP mock) from a genuine auto-attach failure. Missing methods
      // => degrade silently (same-origin behaviour is unaffected). A real client
      // whose setAutoAttach REJECTS is surfaced loudly (console.warn) rather than
      // swallowed, so a broken OOPIF setup on a real browser is not silent.
      const hasOopifApi =
        typeof this.cdp.onAny === 'function' && typeof this.cdp.setAutoAttach === 'function';
      if (hasOopifApi) {
        try {
          // Single firehose handler for target lifecycle. We deliberately use
          // `onAny` (not `onTargetAttached`) for attaches too: `onTargetAttached`
          // hides the PARENT session id, but attach fan-out must be filtered by
          // it (BUG B). In flat mode `Target.attachedToTarget` for a child of
          // session S arrives with a message-level sessionId === S (the parent),
          // delivered here as the third `parentSessionId` argument. Every Page on
          // the connection sees every attach; `handleTargetAttached` only does
          // real setup for children of THIS page's own sessions.
          const anyHandler = (
            method: string,
            params: Record<string, unknown>,
            parentSessionId?: string
          ): void => {
            if (method === 'Target.attachedToTarget') {
              const attachedSessionId = params['sessionId'];
              if (typeof attachedSessionId !== 'string') return;
              void this.handleTargetAttached({
                sessionId: attachedSessionId,
                targetInfo: params['targetInfo'] as {
                  type: string;
                  url: string;
                  targetId: string;
                },
                waitingForDebugger: params['waitingForDebugger'] === true,
                parentSessionId,
              });
            } else if (method === 'Target.detachedFromTarget') {
              // Drop registry entries + active frame session when a child target
              // detaches (frame removed/reloaded/navigated) so we never keep
              // driving a dead session, and `oopifFrames` can't grow unboundedly.
              const sid = params['sessionId'];
              if (typeof sid === 'string') this.dropOopifSession(sid);
            }
          };
          this.oopifAnyHandler = anyHandler;
          this.cdp.onAny(anyHandler);
          // Arm auto-attach on THIS page's pinned session explicitly. Omitting the
          // id resolves to the client's mutable current-default session, which is
          // a race when two pages init concurrently (BUG D).
          await this.cdp.setAutoAttach({ sessionId: this.cdp.sessionId });
          this.oopifAutoAttachInstalled = true;
          // Daemon/shared-connection gap: on a long-lived (daemon) CDP
          // connection, `Target.setAutoAttach` re-armed on a session that
          // already has child targets attached does NOT re-emit
          // `Target.attachedToTarget` for those already-attached children —
          // Chrome only fires it for NEWLY attached/created targets. Without
          // this reconciliation, a `bp` CLI process that attaches to a page
          // via the daemon AFTER an OOPIF child already attached (e.g. the
          // daemon kept the browser connection open across CLI invocations)
          // would see an empty `oopifFrames` registry forever, even though
          // the child session is live on the shared connection. Enumerate
          // existing targets and register any iframe targets that belong to
          // this page's own frame tree through the same
          // `handleTargetAttached` path used for live attach events.
          await this.reconcileExistingOopifTargets();
        } catch (e) {
          // Real client but auto-attach failed: OOPIF frames will be unreachable.
          // Surface it instead of silently degrading.
          console.warn(
            '[browser-pilot] Failed to enable cross-origin iframe (OOPIF) auto-attach; ' +
              `cross-origin frames will not be reachable: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    }

    await this.installEventListenerTracker();
  }

  /**
   * Handle a newly auto-attached flat child session (OOPIF or worker).
   *
   * For iframe targets we enable the DOM/Runtime/Page domains on the child
   * session, arm auto-attach on it (so frames nested INSIDE it — Stripe-like —
   * also attach), and record the frame→session linkage. For EVERY target type
   * (workers included) we finally release it from the `waitForDebuggerOnStart`
   * pause, otherwise a paused child (e.g. a page worker) would hang forever.
   */
  private async handleTargetAttached(info: {
    sessionId: string;
    targetInfo: { type: string; url: string; targetId: string };
    waitingForDebugger: boolean;
    /**
     * Message-level sessionId of the `Target.attachedToTarget` event: the PARENT
     * session the child attached under. Used to reject attaches belonging to
     * OTHER pages (BUG B). Undefined for legacy callers/mocks — treated as owned
     * to preserve prior behaviour.
     */
    parentSessionId?: string;
  }): Promise<void> {
    const { sessionId, targetInfo, parentSessionId } = info;
    // Ownership filter (BUG B): only act on children of a session THIS page owns
    // — its own pinned session, or one of its already-known OOPIF child sessions
    // (nested frames). `onAny` is connection-global, so without this every Page
    // would run Page/DOM/Runtime.enable + setAutoAttach on every other page's
    // iframes and pollute its own `oopifFrames` registry with foreign frames.
    const owned =
      parentSessionId === undefined ||
      parentSessionId === this.cdp.sessionId ||
      this.isKnownChildSession(parentSessionId);
    if (this.disposed || !owned) {
      // Not ours to configure. Still release it from the debugger pause if it is
      // waiting: redundant with the owning page's own unpause (idempotent) but
      // guarantees nothing stalls if no page happens to claim it.
      if (info.waitingForDebugger) {
        try {
          await this.cdp.runIfWaitingForDebugger(sessionId);
        } catch {
          // Session may already be gone; ignore.
        }
      }
      return;
    }
    try {
      if (targetInfo.type === 'iframe') {
        // Fix #2/#4: register the `Runtime.executionContextCreated` listener
        // BEFORE awaiting `Runtime.enable` below. Enabling the Runtime domain can
        // synchronously replay already-existing execution contexts as events;
        // registering the listener only AFTER the `await` resolves would miss any
        // context replayed during that call (event-ordering race). Guarded
        // against double-registration: `handleTargetAttached` can run twice for
        // the same sessionId (once via the live `Target.attachedToTarget` event,
        // once via the daemon-gap reconciliation path), which would otherwise
        // stack duplicate listeners.
        if (
          typeof this.cdp.onSessionEvent === 'function' &&
          !this.oopifSessionUnsubscribers.has(sessionId)
        ) {
          // Fix #2: track execution contexts CREATED WITHIN this OOPIF child
          // session, keyed by frameId. A same-origin iframe nested inside this
          // OOPIF (e.g. a Stripe-Elements-style card-field iframe nested inside a
          // same-origin "controller" iframe that is itself the OOPIF) shares this
          // session/renderer but gets its OWN execution context, distinguishable
          // via `auxData.frameId`. Without this, `evaluate()` while re-rooted onto
          // that nested frame (`oopifFrameRootNodeId`) would silently run in the
          // OOPIF's own top document instead — `document.querySelector` inside
          // `evaluate()` would resolve against the WRONG document. `onSessionEvent`
          // is used (not the page's pinned `on()`) because these events carry the
          // CHILD session's sessionId, which the pinned view does not deliver.
          const unsubscribeCreated = this.cdp.onSessionEvent(
            sessionId,
            'Runtime.executionContextCreated',
            (params) => {
              const context = (
                params as { context: { id: number; auxData?: { frameId?: string } } }
              ).context;
              if (context.auxData?.frameId) {
                this.oopifFrameExecutionContexts.set(context.auxData.frameId, context.id);
              }
            }
          );
          // Prune destroyed contexts (fix #4) so a stale contextId is never
          // reused once the frame reloads/navigates and gets a fresh context.
          const unsubscribeDestroyed = this.cdp.onSessionEvent(
            sessionId,
            'Runtime.executionContextDestroyed',
            (params) => {
              const contextId = (params as { executionContextId: number }).executionContextId;
              for (const [frameId, ctxId] of this.oopifFrameExecutionContexts) {
                if (ctxId === contextId) {
                  this.oopifFrameExecutionContexts.delete(frameId);
                  break;
                }
              }
            }
          );
          this.oopifSessionUnsubscribers.set(sessionId, () => {
            unsubscribeCreated();
            unsubscribeDestroyed();
          });
        }
        await Promise.all([
          this.cdp.send('Page.enable', undefined, sessionId),
          this.cdp.send('DOM.enable', undefined, sessionId),
          this.cdp.send('Runtime.enable', undefined, sessionId),
          // Enable lifecycle events on the child session too, so navigation
          // settling inside the OOPIF sees 'networkIdle' (parity with main).
          this.cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId),
        ]);
        // Descend into nested OOPIFs: arm auto-attach on the child session while
        // it is still paused, so its own children attach when it resumes. The
        // explicit `sessionId` is already the child's own id (not the mutable
        // default), so this arms the correct session.
        await this.cdp.setAutoAttach({ sessionId });
        this.oopifFrames.set(targetInfo.targetId, {
          sessionId,
          targetId: targetInfo.targetId,
          url: targetInfo.url,
        });
      }
    } catch {
      // Best-effort domain setup; still unpause below so nothing stalls.
    } finally {
      // CRITICAL: we set waitForDebuggerOnStart, so every attached child starts
      // paused. Release it (no-op if it wasn't paused) or it never loads.
      try {
        await this.cdp.runIfWaitingForDebugger(sessionId);
      } catch {
        // Session may already be gone; ignore.
      }
    }
  }

  private async installEventListenerTracker(): Promise<void> {
    if (this.blockNativePrint) {
      await this.installNativePrintGuard();
    }

    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: EVENT_LISTENER_TRACKER_SCRIPT,
    });

    try {
      await this.cdp.send('Runtime.evaluate', {
        expression: EVENT_LISTENER_TRACKER_SCRIPT,
      });
    } catch {
      // Ignore failures if no execution context is ready yet; the new-document hook is enough.
    }
  }

  /**
   * Install the native-print guard: register it for every future document AND
   * apply it to the current document (so a page already loaded before init is
   * protected too). Best-effort — failures never block page setup.
   */
  private async installNativePrintGuard(): Promise<void> {
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: BLOCK_NATIVE_PRINT_SCRIPT,
    });
    try {
      await this.cdp.send('Runtime.evaluate', {
        expression: BLOCK_NATIVE_PRINT_SCRIPT,
      });
    } catch {
      // No execution context yet; the new-document hook still covers it.
    }
  }

  // ============ Navigation ============

  /**
   * Navigate to a URL
   */
  async goto(url: string, options: ActionOptions = {}): Promise<void> {
    const { timeout = DEFAULT_TIMEOUT } = options;

    // `optional: true` so the nav wait RESOLVES (false) on timeout instead of
    // throwing — the throw form skipped the state reset below (M1). We surface a
    // URL-specific TimeoutError ourselves after the reset always runs.
    const navPromise = this.waitForNavigation({
      timeout,
      optional: true,
      waitUntil: options.waitUntil ?? 'load',
    });

    await this.cdp.send('Page.navigate', { url });

    let result: boolean;
    try {
      result = await navPromise;
    } finally {
      // ALWAYS refresh DOM/ref state AND reset frame state, even when navigation
      // timed out (M1): the previous document's OOPIF child sessions detach on
      // navigation, so leaving `currentFrameSession` set would keep routing
      // actions to a dead child session.
      this.rootNodeId = null;
      this.refMap.clear();
      this.resetFrameState();
    }

    if (!result) {
      throw new TimeoutError(`Navigation to ${url} timed out after ${timeout}ms`);
    }
  }

  /**
   * Get the current URL
   */
  async url(): Promise<string> {
    const result = await this.cdp.send<{ result: RemoteObject }>('Runtime.evaluate', {
      expression: 'location.href',
      returnByValue: true,
    });
    return result.result.value as string;
  }

  /**
   * Get the page title
   */
  async title(): Promise<string> {
    const result = await this.cdp.send<{ result: RemoteObject }>('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    return result.result.value as string;
  }

  /**
   * Reload the page
   */
  async reload(options: ActionOptions = {}): Promise<void> {
    const { timeout = DEFAULT_TIMEOUT } = options;

    // `optional: true` (as in goto) so the wait RESOLVES(false) on timeout rather
    // than rejecting: a throwing navPromise created BEFORE the `send` below would
    // become an unhandled rejection if `send` throws (BUG E). We surface the
    // timeout ourselves after the reset always runs.
    const navPromise = this.waitForNavigation({
      timeout,
      optional: true,
      waitUntil: options.waitUntil ?? 'load',
    });
    await this.cdp.send('Page.reload');
    let result: boolean;
    try {
      result = await navPromise;
    } finally {
      // ALWAYS reset, even when navigation timed out (M1): frame sessions from
      // the pre-reload document are now dead (M2).
      this.rootNodeId = null;
      this.refMap.clear();
      this.resetFrameState();
    }
    if (!result) {
      throw new TimeoutError(`Reload timed out after ${timeout}ms`);
    }
  }

  /**
   * Go back in history
   */
  async goBack(options: ActionOptions = {}): Promise<void> {
    const { timeout = DEFAULT_TIMEOUT } = options;

    // Get navigation history to find the previous entry
    const history = await this.cdp.send<{
      currentIndex: number;
      entries: Array<{ id: number; url: string }>;
    }>('Page.getNavigationHistory');

    if (history.currentIndex <= 0) {
      // No history to go back to
      return;
    }

    // `optional: true` so an unawaited navPromise can't become an unhandled
    // rejection if the `send` below throws (BUG E); timeout surfaced after reset.
    const navPromise = this.waitForNavigation({
      timeout,
      optional: true,
      waitUntil: options.waitUntil ?? 'load',
      expectedUrl: history.entries[history.currentIndex - 1]!.url,
    });

    // Use CDP navigation instead of history.back() - fires proper events
    await this.cdp.send('Page.navigateToHistoryEntry', {
      entryId: history.entries[history.currentIndex - 1]!.id,
    });

    let result: boolean;
    try {
      result = await navPromise;
    } finally {
      // ALWAYS reset, even when navigation timed out (M1): frame sessions from
      // the previous document are now dead (M2).
      this.rootNodeId = null;
      this.refMap.clear();
      this.resetFrameState();
    }
    if (!result) {
      throw new TimeoutError(`Navigation (back) timed out after ${timeout}ms`);
    }
  }

  /**
   * Go forward in history
   */
  async goForward(options: ActionOptions = {}): Promise<void> {
    const { timeout = DEFAULT_TIMEOUT } = options;

    // Get navigation history to find the next entry
    const history = await this.cdp.send<{
      currentIndex: number;
      entries: Array<{ id: number; url: string }>;
    }>('Page.getNavigationHistory');

    if (history.currentIndex >= history.entries.length - 1) {
      // No history to go forward to
      return;
    }

    // `optional: true` so an unawaited navPromise can't become an unhandled
    // rejection if the `send` below throws (BUG E); timeout surfaced after reset.
    const navPromise = this.waitForNavigation({
      timeout,
      optional: true,
      waitUntil: options.waitUntil ?? 'load',
    });

    // Use CDP navigation instead of history.forward() - fires proper events
    await this.cdp.send('Page.navigateToHistoryEntry', {
      entryId: history.entries[history.currentIndex + 1]!.id,
    });

    let result: boolean;
    try {
      result = await navPromise;
    } finally {
      // ALWAYS reset, even when navigation timed out (M1): frame sessions from
      // the previous document are now dead (M2).
      this.rootNodeId = null;
      this.refMap.clear();
      this.resetFrameState();
    }
    if (!result) {
      throw new TimeoutError(`Navigation (forward) timed out after ${timeout}ms`);
    }
  }

  // ============ Core Actions ============

  /**
   * Click an element (supports multi-selector)
   *
   * Uses CDP mouse events (mouseMoved + mousePressed + mouseReleased) to
   * simulate a real click. Real mouse events on submit buttons naturally
   * trigger native form submission — no JS dispatch needed.
   */
  async click(selector: string | string[], options: ActionOptions = {}): Promise<boolean> {
    return this.withActionDispatch((dispatch) => this.clickInternal(selector, options, dispatch));
  }

  private async clickInternal(
    selector: string | string[],
    options: ActionOptions,
    dispatch: ActionDispatch
  ): Promise<boolean> {
    // Cross-origin (OOPIF) frame active: use element.click() on the child
    // session (coordinate-based dispatch is out of scope for OOPIFs).
    if (this.currentFrameSession) {
      return this.clickInFrame(selector, options, dispatch);
    }
    return this.withStaleNodeRetry(
      async () => {
        const element = await this.findElement(selector, options);
        if (!element) {
          if (options.optional) return false;
          const selectorList = Array.isArray(selector) ? selector : [selector];
          const hints = await generateHints(this, selectorList, 'click');
          throw new ElementNotFoundError(selector, hints);
        }

        await this.scrollIntoView(element.nodeId);

        const objectId = await this.resolveObjectId(element.nodeId);

        // Actionability checks before click
        try {
          await ensureActionable(this.cdp, objectId, ['visible', 'enabled', 'stable'], {
            timeout: options.timeout ?? DEFAULT_TIMEOUT,
          });
        } catch (e) {
          if (
            e instanceof ActionabilityError &&
            e.failureType === 'hitTarget' &&
            (await this.tryClickAssociatedLabel(objectId, dispatch))
          ) {
            return true;
          }
          if (options.optional) return false;
          throw e;
        }

        // Compute click coordinates for hit target check
        let clickX: number;
        let clickY: number;
        try {
          const { quads } = await this.cdp.send<{ quads: number[][] }>('DOM.getContentQuads', {
            objectId,
          });
          if (quads?.length > 0) {
            const quad = quads[0]!;
            clickX = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
            clickY = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
            const minX = Math.min(quad[0]!, quad[2]!, quad[4]!, quad[6]!);
            const maxX = Math.max(quad[0]!, quad[2]!, quad[4]!, quad[6]!);
            const minY = Math.min(quad[1]!, quad[3]!, quad[5]!, quad[7]!);
            const maxY = Math.max(quad[1]!, quad[3]!, quad[5]!, quad[7]!);
            this.setLastActionPosition(
              { x: clickX, y: clickY },
              { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
            );
          } else {
            throw new Error('No quads');
          }
        } catch {
          const box = await this.getBoxModel(element.nodeId);
          if (!box) throw new Error('Could not get element position');
          clickX = box.content[0]! + box.width / 2;
          clickY = box.content[1]! + box.height / 2;
          this.setLastActionPosition(
            { x: clickX, y: clickY },
            { x: box.content[0]!, y: box.content[1]!, width: box.width, height: box.height }
          );
        }

        // Hit target checks inside iframes need frame-local coordinates, while
        // Input.dispatchMouseEvent still needs the page-level coordinates above.
        const hitTargetCoordinates = this.currentFrame ? undefined : { x: clickX, y: clickY };

        // Hit target check with bounded retry for transient overlays
        const HIT_TARGET_RETRIES = 3;
        const HIT_TARGET_DELAY = 100;

        // Snapshot checkbox/radio state before any possible label or mouse
        // dispatch so label-driven controls can be verified without a second
        // effectful input event.
        const toggleBefore = await this.readToggleState(objectId);

        // A pointer-events:none input cannot receive the coordinate event even
        // when its center otherwise looks actionable. Choose its label before
        // dispatching any mouse event.
        if (
          toggleBefore &&
          (await this.hasPointerEventsNone(objectId)) &&
          (await this.tryClickAssociatedLabel(objectId, dispatch))
        ) {
          const expected = toggleBefore.isRadio ? true : !toggleBefore.checked;
          await this.ensureToggleRegistered(objectId, expected);
          return true;
        }

        for (let attempt = 0; attempt < HIT_TARGET_RETRIES; attempt++) {
          try {
            await ensureActionable(this.cdp, objectId, ['hitTarget'], {
              timeout: options.timeout ?? DEFAULT_TIMEOUT,
              coordinates: hitTargetCoordinates,
            });
            break;
          } catch (e) {
            if (options.optional) return false;
            if (
              e instanceof ActionabilityError &&
              e.failureType === 'hitTarget' &&
              (await this.tryClickAssociatedLabel(objectId, dispatch))
            ) {
              if (toggleBefore) {
                const expected = toggleBefore.isRadio ? true : !toggleBefore.checked;
                await this.ensureToggleRegistered(objectId, expected);
              }
              return true;
            }
            if (
              e instanceof ActionabilityError &&
              e.failureType === 'hitTarget' &&
              attempt < HIT_TARGET_RETRIES - 1
            ) {
              await sleep(HIT_TARGET_DELAY);
              // Re-scroll in case layout shifted
              await this.cdp.send('DOM.scrollIntoViewIfNeeded', { nodeId: element.nodeId });
              continue;
            }
            throw e;
          }
        }

        await this.clickElement(element.nodeId, dispatch);

        if (toggleBefore) {
          // A genuine user click toggles a checkbox / selects a radio AND fires
          // bubbling input + change. The trusted CDP mouse click normally does this
          // on its own. Verification is observation only; label-driven controls
          // are selected before dispatch above.
          const expected = toggleBefore.isRadio ? true : !toggleBefore.checked;
          await this.ensureToggleRegistered(objectId, expected);
        }
        return true;
      },
      { dispatch }
    );
  }

  /**
   * Read whether an element is a checkbox/radio and its current checked state.
   * Returns null for any other element so plain clicks (buttons/links) are untouched.
   */
  private async readToggleState(
    objectId: string
  ): Promise<{ isRadio: boolean; checked: boolean } | null> {
    const res = await this.cdp.send<{
      result: { value: { isRadio: boolean; checked: boolean } | null };
    }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        if (!(this instanceof HTMLInputElement)) return null;
        var t = String(this.type || '').toLowerCase();
        if (t !== 'checkbox' && t !== 'radio') return null;
        return { isRadio: t === 'radio', checked: !!this.checked };
      }`,
      returnByValue: true,
    });
    return res.result.value ?? null;
  }

  private async hasPointerEventsNone(objectId: string): Promise<boolean> {
    try {
      const result = await this.cdp.send<{ result: { value: boolean } }>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration:
          'function() { return getComputedStyle(this).pointerEvents === "none"; }',
        returnByValue: true,
      });
      return result.result.value === true;
    } catch {
      return false;
    }
  }

  /**
   * After a trusted click on a checkbox/radio, observe whether the toggle
   * registered. This is deliberately not a recovery path: a second label click
   * or synthetic event could duplicate an already accepted effect.
   */
  private async ensureToggleRegistered(objectId: string, expected: boolean): Promise<void> {
    let actual: boolean;
    try {
      actual = await this.readCheckedState(objectId);
    } catch {
      // Node detached (e.g. the click navigated) — nothing to verify.
      return;
    }
    if (actual === expected) return; // Trusted click already did the right thing.

    throw new Error(
      `Click was dispatched but toggle state did not become ${expected ? 'checked' : 'unchecked'}`
    );
  }

  /**
   * Fill an input field (clears first by default)
   */
  async fill(
    selector: string | string[],
    value: string,
    options: FillOptions = {}
  ): Promise<boolean> {
    const { blur = false } = options;

    // Cross-origin (OOPIF) frame active: focus + Input.insertText on the child
    // session (coordinate geometry / special-input handling is out of scope).
    if (this.currentFrameSession) {
      return this.withActionDispatch((dispatch) =>
        this.fillInFrame(selector, value, options, dispatch)
      );
    }

    return this.withActionDispatch((dispatch) =>
      this.withStaleNodeRetry(
        async () => {
          const element = await this.findElement(selector, options);

          if (!element) {
            if (options.optional) return false;
            const selectorList = Array.isArray(selector) ? selector : [selector];
            const hints = await generateHints(this, selectorList, 'fill');
            throw new ElementNotFoundError(selector, hints);
          }

          // Resolve nodeId to objectId for Runtime.callFunctionOn
          const { object } = await this.cdp.send<{ object: { objectId: string } }>(
            'DOM.resolveNode',
            {
              nodeId: element.nodeId,
            }
          );
          const objectId = object.objectId;

          // Actionability checks before fill
          try {
            await ensureActionable(this.cdp, objectId, ['visible', 'enabled', 'editable'], {
              timeout: options.timeout ?? DEFAULT_TIMEOUT,
            });
          } catch (e) {
            if (options.optional) return false;
            throw e;
          }

          const fillPos = await this.getElementPosition({ nodeId: element.nodeId });
          if (fillPos) this.setLastActionPosition(fillPos.center, fillPos.bbox);

          // Check if this is a special input type that can't use Input.insertText
          const tagInfo = await this.cdp.send<{
            result: { value: { tagName: string; inputType: string; autocomplete: string } };
          }>('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: `function() {
            return {
              tagName: this.tagName?.toLowerCase() || '',
              inputType: (this.type || '').toLowerCase(),
              autocomplete: typeof this.autocomplete === 'string' ? this.autocomplete.toLowerCase() : '',
            };
          }`,
            returnByValue: true,
          });
          this._lastActionTargetMetadata = tagInfo.result.value;
          const { tagName, inputType } = tagInfo.result.value;
          const specialInputTypes = new Set([
            'date',
            'datetime-local',
            'month',
            'week',
            'time',
            'color',
            'range',
            'file',
          ]);
          const isSpecialInput = tagName === 'input' && specialInputTypes.has(inputType);

          if (isSpecialInput) {
            // Special inputs: set value directly + dispatch events
            await dispatch.send(
              () =>
                this.cdp.send('Runtime.callFunctionOn', {
                  objectId,
                  functionDeclaration: `function(val) {
                this.value = val;
                this.dispatchEvent(new Event('input', { bubbles: true }));
                this.dispatchEvent(new Event('change', { bubbles: true }));
              }`,
                  arguments: [{ value }],
                  returnByValue: true,
                }),
              'fillValue'
            );
          } else {
            // Playwright pattern: focus + select all, then insertText/Delete.
            await this.selectEditableContent(objectId);

            if (value === '') {
              // Empty value: send Delete key to clear selected text (Playwright pattern)
              await this.dispatchKey('Delete', undefined, dispatch);
            } else {
              // Non-empty: Input.insertText fires real isTrusted:true events
              await dispatch.send(
                () => this.cdp.send('Input.insertText', { text: value }),
                'insertText'
              );
            }
          }

          if (options.verify !== false) {
            const verifyMode = options.verify === 'normalized' ? 'normalized' : 'exact';
            let actualValue = await this.readEditableValue(objectId);
            let matches =
              verifyMode === 'normalized'
                ? fillValuesMatchNormalized(value, actualValue)
                : actualValue === value;

            if (!matches && !isSpecialInput) {
              if (value === '') {
                await this.clearEditableSelection(objectId, 'Backspace', dispatch);
              } else {
                await this.typeEditableFallback(element.nodeId, objectId, value, dispatch);
              }
              actualValue = await this.readEditableValue(objectId);
              matches =
                verifyMode === 'normalized'
                  ? fillValuesMatchNormalized(value, actualValue)
                  : actualValue === value;
            }

            if (!matches) {
              if (options.optional) return false;
              throw new Error(
                `Fill value did not stick. Expected ${JSON.stringify(value)} but got ${JSON.stringify(actualValue)}.`
              );
            }
          }

          // Optionally trigger blur
          if (blur) {
            await this.cdp.send('Runtime.callFunctionOn', {
              objectId,
              functionDeclaration: 'function() { this.blur(); }',
            });
          }

          return true;
        },
        { dispatch }
      )
    );
  }

  /**
   * Type text character by character (for autocomplete fields, etc.)
   *
   * Uses proper keyDown/rawKeyDown distinction with US keyboard layout.
   * Printable chars use 'keyDown' with text, non-text keys use 'rawKeyDown',
   * and non-layout chars (emoji, CJK) fall back to Input.insertText.
   */
  async type(
    selector: string | string[],
    text: string,
    options: TypeOptions = {}
  ): Promise<boolean> {
    // Cross-origin (OOPIF) frame active: focus + per-key dispatch on the child
    // session (needed for checkout card entry). Routed before findElement so it
    // cannot silently resolve against the parent session.
    if (this.currentFrameSession) {
      return this.withActionDispatch((dispatch) =>
        this.typeInFrame(selector, text, options, dispatch)
      );
    }
    return this.withActionDispatch((dispatch) =>
      this.withStaleNodeRetry(
        async () => {
          const { delay = 50 } = options;
          const element = await this.findElement(selector, options);

          if (!element) {
            if (options.optional) return false;
            throw new ElementNotFoundError(selector);
          }

          // Actionability checks before typing
          const objectId = await this.resolveObjectId(element.nodeId);
          try {
            await ensureActionable(this.cdp, objectId, ['visible', 'enabled'], {
              timeout: options.timeout ?? DEFAULT_TIMEOUT,
            });
          } catch (e) {
            if (options.optional) return false;
            throw e;
          }

          const typePos = await this.getElementPosition({ nodeId: element.nodeId });
          if (typePos) this.setLastActionPosition(typePos.center, typePos.bbox);
          this._lastActionTargetMetadata = await this.getActionTargetMetadata({ objectId });

          await this.cdp.send('DOM.focus', { nodeId: element.nodeId });
          const beforeState = await this.readEditableState(objectId);

          for (const char of text) {
            const def = US_KEYBOARD[char];

            if (def) {
              await this.dispatchKeyDefinition(def, 0, undefined, dispatch);
            } else {
              // Non-layout character (emoji, CJK): use insertText
              await dispatch.send(
                () => this.cdp.send('Input.insertText', { text: char }),
                'insertText'
              );
            }

            if (delay > 0) {
              await sleep(delay);
            }
          }

          // Input.dispatchKeyEvent can acknowledge successfully without
          // editing a background target. Input.insertText works without
          // activating the tab, so use it only when the key path had no effect.
          const afterState = await this.readEditableState(objectId);
          if (
            text.length > 0 &&
            beforeState.value === afterState.value &&
            beforeState.selectionStart === afterState.selectionStart &&
            beforeState.selectionEnd === afterState.selectionEnd
          ) {
            await dispatch.send(() => this.cdp.send('Input.insertText', { text }), 'insertText');
          }

          // Optionally trigger blur
          if (options.blur) {
            await this.cdp.send('Runtime.callFunctionOn', {
              objectId,
              functionDeclaration: 'function() { this.blur(); }',
            });
          }

          return true;
        },
        { dispatch }
      )
    );
  }

  /**
   * Select option(s) from a native select element
   */
  async select(
    selector: string | string[],
    value: string | string[],
    options?: ActionOptions
  ): Promise<boolean>;
  async select(config: CustomSelectConfig, options?: ActionOptions): Promise<boolean>;
  async select(
    selectorOrConfig: string | string[] | CustomSelectConfig,
    valueOrOptions?: string | string[] | ActionOptions,
    maybeOptions?: ActionOptions
  ): Promise<boolean> {
    this.assertOopifUnsupported('select');
    // Handle custom select config
    if (
      typeof selectorOrConfig === 'object' &&
      !Array.isArray(selectorOrConfig) &&
      'trigger' in selectorOrConfig
    ) {
      return this.selectCustom(selectorOrConfig, valueOrOptions as ActionOptions);
    }

    const selector = selectorOrConfig;
    const value = valueOrOptions as string | string[];
    const options = maybeOptions ?? {};

    return this.withActionDispatch((dispatch) =>
      this.withStaleNodeRetry(
        async () => {
          const element = await this.findElement(selector, options);
          if (!element) {
            if (options.optional) return false;
            const selectorList = Array.isArray(selector) ? selector : [selector];
            const hints = await generateHints(this, selectorList, 'select');
            throw new ElementNotFoundError(selector, hints);
          }

          const values = Array.isArray(value) ? value : [value];
          const objectId = await this.resolveObjectId(element.nodeId);

          try {
            await this.scrollIntoView(element.nodeId);
            await ensureActionable(this.cdp, objectId, ['visible', 'enabled'], {
              timeout: options.timeout ?? DEFAULT_TIMEOUT,
            });
          } catch (e) {
            if (options.optional) return false;
            throw e;
          }

          const selectPos = await this.getElementPosition({ nodeId: element.nodeId });
          if (selectPos) this.setLastActionPosition(selectPos.center, selectPos.bbox);
          this._lastActionTargetMetadata = await this.getActionTargetMetadata({ objectId });

          const metadata = await this.getNativeSelectMetadata(objectId, values);
          if (!metadata.isSelect) {
            throw new Error('select() target must be a native <select> element');
          }
          if (metadata.missing.length > 0) {
            throw new Error(`No option found for: ${metadata.missing.join(', ')}`);
          }
          if (metadata.disabled.length > 0) {
            throw new Error(`Cannot select disabled option(s): ${metadata.disabled.join(', ')}`);
          }
          if (!metadata.multiple && metadata.targetIndexes.length > 1) {
            throw new Error('Cannot select multiple values on a single-select element');
          }

          const expectedValues = metadata.targetIndexes.map((idx) => metadata.options[idx]!.value);
          if (this.selectValuesMatch(metadata.selectedValues, expectedValues, metadata.multiple)) {
            return true;
          }

          if (!metadata.multiple && metadata.targetIndexes.length === 1) {
            await this.applyNativeSelectByKeyboard(
              element.nodeId,
              objectId,
              metadata.currentIndex,
              metadata.targetIndexes[0]!,
              dispatch
            );
          }

          let selectedValues = await this.readNativeSelectValues(objectId);
          if (!this.selectValuesMatch(selectedValues, expectedValues, metadata.multiple)) {
            await this.applyNativeSelectFallback(objectId, metadata.targetIndexes, dispatch);
            selectedValues = await this.readNativeSelectValues(objectId);
          }

          if (!this.selectValuesMatch(selectedValues, expectedValues, metadata.multiple)) {
            await this.applyRecordedSelectFallback(objectId, metadata.targetIndexes, dispatch);
            selectedValues = await this.readNativeSelectValues(objectId);
          }

          if (!this.selectValuesMatch(selectedValues, expectedValues, metadata.multiple)) {
            if (options.optional) return false;
            throw new Error(
              `Select value did not stick. Expected ${expectedValues.join(', ') || '(empty)'} but got ${selectedValues.join(', ') || '(empty)'}.`
            );
          }

          return true;
        },
        { dispatch }
      )
    );
  }

  /**
   * Handle custom (non-native) select/dropdown components
   */
  private async selectCustom(
    config: CustomSelectConfig,
    options: ActionOptions = {}
  ): Promise<boolean> {
    const { trigger, option, value, match = 'text' } = config;

    return this.withActionDispatch((dispatch) =>
      this.withStaleNodeRetry(
        async () => {
          // Click the trigger to open dropdown
          await this.clickInternal(trigger, options, dispatch);

          // Wait for dropdown to appear (up to 500ms) instead of fixed delay
          const optionSelectors = Array.isArray(option) ? option : [option];
          await waitForAnyElement(this.cdp, optionSelectors, {
            state: 'visible',
            timeout: 500,
            contextId: this.currentFrameContextId ?? undefined,
          }).catch(() => sleep(100)); // Fallback to brief delay if we can't detect
          const optionHandle = await this.evaluateInFrame<{ result: RemoteObject }>(
            `(() => {
          const selectors = ${JSON.stringify(optionSelectors)};
          const wanted = ${JSON.stringify(value)};
          const mode = ${JSON.stringify(match)};

          for (const selector of selectors) {
            const candidates = document.querySelectorAll(selector);
            for (const candidate of candidates) {
              const text = candidate.textContent?.trim() || '';
              const candidateValue =
                candidate.getAttribute?.('data-value') ??
                candidate.getAttribute?.('value') ??
                candidate.value ??
                '';
              const matches =
                mode === 'value'
                  ? candidateValue === wanted
                  : mode === 'contains'
                    ? text.includes(wanted)
                    : text === wanted;

              if (matches) {
                return candidate;
              }
            }
          }

          return null;
        })()`,
            { returnByValue: false }
          );

          if (!optionHandle.result.objectId) {
            if (options.optional) return false;
            throw new ElementNotFoundError(`Option with ${match} "${value}"`);
          }

          const nodeResult = await this.cdp.send<{ nodeId: number }>('DOM.requestNode', {
            objectId: optionHandle.result.objectId,
          });

          if (!nodeResult.nodeId) {
            if (options.optional) return false;
            throw new ElementNotFoundError(`Option with ${match} "${value}"`);
          }

          await this.scrollIntoView(nodeResult.nodeId);
          await ensureActionable(
            this.cdp,
            optionHandle.result.objectId,
            ['visible', 'enabled', 'stable'],
            {
              timeout: options.timeout ?? DEFAULT_TIMEOUT,
            }
          );
          await this.clickElement(nodeResult.nodeId, dispatch);
          return true;
        },
        { dispatch }
      )
    );
  }

  /**
   * Check a checkbox or radio button using real mouse click.
   * No-op if already checked. Verifies state changed after click.
   */
  async check(selector: string | string[], options: ActionOptions = {}): Promise<boolean> {
    this.assertOopifUnsupported('check');
    return this.withActionDispatch((dispatch) =>
      this.withStaleNodeRetry(
        async () => {
          const element = await this.findElement(selector, options);
          if (!element) {
            if (options.optional) return false;
            const selectorList = Array.isArray(selector) ? selector : [selector];
            const hints = await generateHints(this, selectorList, 'check');
            throw new ElementNotFoundError(selector, hints);
          }

          const { object } = await this.cdp.send<{ object: { objectId: string } }>(
            'DOM.resolveNode',
            {
              nodeId: element.nodeId,
            }
          );

          // Actionability checks
          try {
            await ensureActionable(this.cdp, object.objectId, ['visible', 'enabled'], {
              timeout: options.timeout ?? DEFAULT_TIMEOUT,
            });
          } catch (e) {
            if (options.optional) return false;
            throw e;
          }

          const checkPos = await this.getElementPosition({ nodeId: element.nodeId });
          if (checkPos) this.setLastActionPosition(checkPos.center, checkPos.bbox);

          // Read current checked state
          const before = await this.cdp.send<{ result: { value: boolean } }>(
            'Runtime.callFunctionOn',
            {
              objectId: object.objectId,
              functionDeclaration: 'function() { return !!this.checked; }',
              returnByValue: true,
            }
          );

          if (before.result.value) return true; // Already checked

          // Prefer the associated label when one exists. This is a
          // pre-dispatch choice that supports controls whose input handler
          // intentionally prevents the native input click; verification below
          // remains observation-only.
          if (await this.tryClickAssociatedLabel(object.objectId, dispatch)) {
            const afterLabel = await this.readCheckedState(object.objectId);
            if (!afterLabel) {
              throw new Error('Label click was dispatched but checkbox did not become checked');
            }
            return true;
          }

          // No associated label: dispatch directly to the input.
          await this.scrollIntoView(element.nodeId);
          await this.clickElement(element.nodeId, dispatch);

          // Verify state changed
          const after = await this.cdp.send<{ result: { value: boolean } }>(
            'Runtime.callFunctionOn',
            {
              objectId: object.objectId,
              functionDeclaration: 'function() { return !!this.checked; }',
              returnByValue: true,
            }
          );

          if (!after.result.value) {
            throw new Error('Click was dispatched but checkbox did not become checked');
          }

          return true;
        },
        { dispatch }
      )
    );
  }

  /**
   * Uncheck a checkbox using real mouse click.
   * No-op if already unchecked. Radio buttons can't be unchecked (returns true).
   */
  async uncheck(selector: string | string[], options: ActionOptions = {}): Promise<boolean> {
    this.assertOopifUnsupported('uncheck');
    return this.withActionDispatch((dispatch) =>
      this.withStaleNodeRetry(
        async () => {
          const element = await this.findElement(selector, options);
          if (!element) {
            if (options.optional) return false;
            const selectorList = Array.isArray(selector) ? selector : [selector];
            const hints = await generateHints(this, selectorList, 'uncheck');
            throw new ElementNotFoundError(selector, hints);
          }

          const { object } = await this.cdp.send<{ object: { objectId: string } }>(
            'DOM.resolveNode',
            {
              nodeId: element.nodeId,
            }
          );

          // Actionability checks
          try {
            await ensureActionable(this.cdp, object.objectId, ['visible', 'enabled'], {
              timeout: options.timeout ?? DEFAULT_TIMEOUT,
            });
          } catch (e) {
            if (options.optional) return false;
            throw e;
          }

          const uncheckPos = await this.getElementPosition({ nodeId: element.nodeId });
          if (uncheckPos) this.setLastActionPosition(uncheckPos.center, uncheckPos.bbox);

          // Check if it's a radio button (can't uncheck radio by clicking)
          const isRadio = await this.cdp.send<{ result: { value: boolean } }>(
            'Runtime.callFunctionOn',
            {
              objectId: object.objectId,
              functionDeclaration: 'function() { return this.type === "radio"; }',
              returnByValue: true,
            }
          );

          if (isRadio.result.value) return true;

          // Read current checked state
          const before = await this.cdp.send<{ result: { value: boolean } }>(
            'Runtime.callFunctionOn',
            {
              objectId: object.objectId,
              functionDeclaration: 'function() { return !!this.checked; }',
              returnByValue: true,
            }
          );

          if (!before.result.value) return true; // Already unchecked

          if (await this.tryClickAssociatedLabel(object.objectId, dispatch)) {
            const afterLabel = await this.readCheckedState(object.objectId);
            if (afterLabel) {
              throw new Error('Label click was dispatched but checkbox remained checked');
            }
            return true;
          }

          // No associated label: dispatch directly to the input.
          await this.scrollIntoView(element.nodeId);
          await this.clickElement(element.nodeId, dispatch);

          // Verify state changed
          const after = await this.cdp.send<{ result: { value: boolean } }>(
            'Runtime.callFunctionOn',
            {
              objectId: object.objectId,
              functionDeclaration: 'function() { return !!this.checked; }',
              returnByValue: true,
            }
          );

          if (after.result.value) {
            throw new Error('Click was dispatched but checkbox remained checked');
          }

          return true;
        },
        { dispatch }
      )
    );
  }

  /**
   * Submit a form with one effectful dispatch.
   * `enter+click` uses the trusted mouse click path; it never sends Enter and
   * then clicks the same control after an uncertain key dispatch.
   *
   * Navigation waiting behavior:
   * - 'auto' (default): Attempt to detect navigation for 1 second, then assume client-side handling
   * - true: Wait for full navigation (traditional forms)
   * - false: Return immediately (AJAX forms where you'll wait for something else)
   *
   * When targeting a <form> element directly, uses form.requestSubmit() which fires
   * the submit event and triggers HTML5 validation.
   */
  async submit(selector: string | string[], options: SubmitOptions = {}): Promise<boolean> {
    this.assertOopifUnsupported('submit');
    return this.withActionDispatch((dispatch) =>
      this.withStaleNodeRetry(
        async () => {
          const { method = 'enter+click', waitForNavigation: shouldWait = 'auto' } = options;
          const element = await this.findElement(selector, options);

          if (!element) {
            if (options.optional) return false;
            const selectorList = Array.isArray(selector) ? selector : [selector];
            const hints = await generateHints(this, selectorList, 'submit');
            throw new ElementNotFoundError(selector, hints);
          }

          const objectId = await this.resolveObjectId(element.nodeId);
          const submitPos = await this.getElementPosition({ nodeId: element.nodeId });
          if (submitPos) this.setLastActionPosition(submitPos.center, submitPos.bbox);

          const isFormElement = await this.cdp.send<{ result: { value: boolean } }>(
            'Runtime.callFunctionOn',
            {
              objectId,
              functionDeclaration: 'function() { return this instanceof HTMLFormElement; }',
              returnByValue: true,
            }
          );

          if (isFormElement.result.value) {
            // For form elements, use requestSubmit() which fires submit event and validates
            await dispatch.send(
              () =>
                this.cdp.send('Runtime.callFunctionOn', {
                  objectId,
                  functionDeclaration: `function() {
                if (typeof this.requestSubmit === 'function') {
                  this.requestSubmit();
                } else {
                  this.submit();
                }
              }`,
                }),
              'requestSubmit'
            );

            // Handle navigation waiting
            if (shouldWait === true) {
              const observed = await this.waitForNavigation({
                timeout: options.timeout ?? DEFAULT_TIMEOUT,
                waitUntil: options.waitUntil ?? 'load',
              });
              if (observed) dispatch.observeNavigation();
            } else if (shouldWait === 'auto') {
              const result = await Promise.race([
                this.waitForNavigation({
                  timeout: 2000,
                  optional: true,
                  waitUntil: options.waitUntil ?? 'load',
                }).then((observed) => {
                  if (observed) dispatch.observeNavigation();
                  return 'navigation' as const;
                }),
                this.waitForDOMMutation({ timeout: 1000 }).then(() => 'mutation' as const),
                sleep(1500).then(() => 'timeout' as const),
              ]);
              void result;
            }
            return true;
          }

          // For non-form elements, continue with existing focus+enter/click logic
          await this.cdp.send('DOM.focus', { nodeId: element.nodeId });

          // An explicit Enter request is one effectful dispatch. The
          // enter+click mode intentionally uses the click path below so it
          // cannot send two potentially submitting inputs.
          if (method === 'enter') {
            await this.pressInternal('Enter', undefined, dispatch);

            if (shouldWait === true) {
              const observed = await this.waitForNavigation({
                timeout: options.timeout ?? DEFAULT_TIMEOUT,
                waitUntil: options.waitUntil ?? 'load',
              });
              if (observed) dispatch.observeNavigation();
            } else if (shouldWait === 'auto') {
              const result = await Promise.race([
                this.waitForNavigation({
                  timeout: 2000,
                  optional: true,
                  waitUntil: options.waitUntil ?? 'load',
                }).then((observed) => {
                  if (observed) dispatch.observeNavigation();
                  return observed ? ('nav' as const) : null;
                }),
                this.waitForDOMMutation({ timeout: 1000 }).then(() => 'mutation' as const),
                sleep(1500).then(() => 'timeout' as const),
              ]);
              void result;
            } else {
              // waitForNavigation: false - don't wait
            }

            return true;
          }

          // Try click if method includes it
          if (method.includes('click')) {
            await this.clickInternal(element.selector, { ...options, optional: false }, dispatch);

            if (shouldWait === true) {
              const observed = await this.waitForNavigation({
                timeout: options.timeout ?? DEFAULT_TIMEOUT,
                waitUntil: options.waitUntil ?? 'load',
              });
              if (observed) dispatch.observeNavigation();
            } else if (shouldWait === 'auto') {
              // Short wait to allow client-side handlers to run
              await sleep(100);
            }
            // waitForNavigation: false - return immediately
          }

          return true;
        },
        { dispatch }
      )
    );
  }

  /**
   * Press a key, optionally with modifier keys held down
   */
  async press(
    key: string,
    options?: { modifiers?: Array<'Control' | 'Shift' | 'Alt' | 'Meta'> }
  ): Promise<void> {
    return this.withActionDispatch((dispatch) =>
      this.pressInternal(key, options?.modifiers, dispatch)
    );
  }

  private async pressInternal(
    key: string,
    modifiers: Array<'Control' | 'Shift' | 'Alt' | 'Meta'> | undefined,
    dispatch: ActionDispatch
  ): Promise<void> {
    // Route keystrokes to the active OOPIF child session so they reach the
    // focused in-frame element, not the parent (needed for checkout card entry).
    const sessionId = this.currentFrameSession ?? undefined;
    if (modifiers && modifiers.length > 0) {
      await this.dispatchKeyWithModifiers(key, modifiers, sessionId, dispatch);
    } else {
      await this.dispatchKey(key, sessionId, dispatch);
    }
  }

  /**
   * Execute a keyboard shortcut (e.g. "Control+a", "Meta+Shift+z")
   */
  async shortcut(combo: string): Promise<void> {
    return this.withActionDispatch(async (dispatch) => {
      const { modifiers, key } = parseShortcut(combo);
      // Route to the active OOPIF child session when inside a cross-origin frame.
      const sessionId = this.currentFrameSession ?? undefined;
      await this.dispatchKeyWithModifiers(key, modifiers, sessionId, dispatch);

      // Chrome does not consistently apply modifier selection shortcuts to a
      // CDP-controlled background target. Preserve the browser shortcut event,
      // then repair the common editable-field case without activating the tab.
      if (
        key.toLowerCase() === 'a' &&
        (modifiers.includes('Control') || modifiers.includes('Meta'))
      ) {
        await this.selectAllActiveEditable(sessionId);
      }
    });
  }

  /**
   * Focus an element
   */
  async focus(selector: string | string[], options: ActionOptions = {}): Promise<boolean> {
    // Cross-origin (OOPIF) frame active: focus on the child session so the real
    // in-frame field receives focus (routed before findElement).
    if (this.currentFrameSession) {
      return this.focusInFrame(selector, options);
    }
    const element = await this.findElement(selector, options);
    if (!element) {
      if (options.optional) return false;
      const selectorList = Array.isArray(selector) ? selector : [selector];
      const hints = await generateHints(this, selectorList, 'focus');
      throw new ElementNotFoundError(selector, hints);
    }

    const focusPos = await this.getElementPosition({ nodeId: element.nodeId });
    if (focusPos) this.setLastActionPosition(focusPos.center, focusPos.bbox);

    await this.cdp.send('DOM.focus', { nodeId: element.nodeId });
    return true;
  }

  /**
   * Hover over an element
   */
  async hover(selector: string | string[], options: ActionOptions = {}): Promise<boolean> {
    this.assertOopifUnsupported('hover');
    return this.withStaleNodeRetry(async () => {
      const element = await this.findElement(selector, options);
      if (!element) {
        if (options.optional) return false;
        const selectorList = Array.isArray(selector) ? selector : [selector];
        const hints = await generateHints(this, selectorList, 'hover');
        throw new ElementNotFoundError(selector, hints);
      }

      await this.scrollIntoView(element.nodeId);

      const objectId = await this.resolveObjectId(element.nodeId);

      // Actionability checks
      try {
        await ensureActionable(this.cdp, objectId, ['visible', 'stable'], {
          timeout: options.timeout ?? DEFAULT_TIMEOUT,
        });
      } catch (e) {
        if (options.optional) return false;
        throw e;
      }

      // Use getContentQuads for precise coordinates (handles CSS transforms)
      let x: number;
      let y: number;
      try {
        const { quads } = await this.cdp.send<{ quads: number[][] }>('DOM.getContentQuads', {
          objectId,
        });
        if (quads?.length > 0) {
          const quad = quads[0]!;
          x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
          y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
          const minX = Math.min(quad[0]!, quad[2]!, quad[4]!, quad[6]!);
          const maxX = Math.max(quad[0]!, quad[2]!, quad[4]!, quad[6]!);
          const minY = Math.min(quad[1]!, quad[3]!, quad[5]!, quad[7]!);
          const maxY = Math.max(quad[1]!, quad[3]!, quad[5]!, quad[7]!);
          this.setLastActionPosition(
            { x, y },
            { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
          );
        } else {
          throw new Error('No quads');
        }
      } catch {
        const box = await this.getBoxModel(element.nodeId);
        if (!box) {
          if (options.optional) return false;
          throw new Error('Could not get element position');
        }
        x = box.content[0]! + box.width / 2;
        y = box.content[1]! + box.height / 2;
        this.setLastActionPosition(
          { x, y },
          { x: box.content[0]!, y: box.content[1]!, width: box.width, height: box.height }
        );
      }

      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
      });

      return true;
    });
  }

  /**
   * Scroll an element into view (or scroll to coordinates)
   */
  async scroll(
    selector: string | string[],
    options: ActionOptions & { x?: number; y?: number } = {}
  ): Promise<boolean> {
    this.assertOopifUnsupported('scroll');
    const { x, y } = options;

    // If x/y provided, scroll the page
    if (x !== undefined || y !== undefined) {
      await this.cdp.send('Runtime.evaluate', {
        expression: `window.scrollTo(${x ?? 0}, ${y ?? 0})`,
      });
      return true;
    }

    // Otherwise scroll element into view
    const element = await this.findElement(selector, options);
    if (!element) {
      if (options.optional) return false;
      throw new ElementNotFoundError(selector);
    }

    const scrollPos = await this.getElementPosition({ nodeId: element.nodeId });
    if (scrollPos) this.setLastActionPosition(scrollPos.center, scrollPos.bbox);

    await this.scrollIntoView(element.nodeId);
    return true;
  }

  // ============ Frame Navigation ============

  /**
   * Switch context to an iframe for subsequent actions
   * @param selector - Selector for the iframe element
   * @param options - Optional timeout and optional flags
   * @returns true if switch succeeded
   */
  async switchToFrame(selector: string | string[], options: ActionOptions = {}): Promise<boolean> {
    const frameKey = Array.isArray(selector) ? selector[0]! : selector;

    // Nested descent: we are already inside an OOPIF child session, so the
    // target <iframe> element lives in THAT session (rooted at
    // `oopifFrameRootNodeId` if we already descended into a same-origin nested
    // frame). Resolve it there and either (a) re-root onto it if it is a
    // SAME-ORIGIN child of the current document (fix #2 — e.g. a real
    // Stripe-Elements-style card-field iframe nested inside a same-origin
    // "controller" iframe that is itself the cross-origin OOPIF), or (b)
    // descend into its own (grand)child OOPIF session if it is ITSELF
    // cross-origin.
    if (this.currentFrameSession) {
      const sessionId = this.currentFrameSession;
      const timeout = options.timeout ?? DEFAULT_TIMEOUT;
      const nestedElement = await this.findElementInSession(selector, sessionId, timeout);
      if (!nestedElement) {
        if (options.optional) return false;
        throw new ElementNotFoundError(selector);
      }
      const desc = await this.cdp
        .send<{
          node: { contentDocument?: { nodeId: number }; frameId?: string };
        }>('DOM.describeNode', { objectId: nestedElement.objectId, depth: 1 }, sessionId)
        .catch(
          () =>
            ({ node: {} }) as { node: { contentDocument?: { nodeId: number }; frameId?: string } }
        );

      // (a) SAME-ORIGIN nested frame (fix #2): its contentDocument is directly
      // reachable from the PARENT OOPIF's own session — re-root subsequent
      // in-frame queries onto it without leaving `currentFrameSession`.
      if (desc.node.contentDocument?.nodeId !== undefined) {
        this.oopifFrameRootNodeId = desc.node.contentDocument.nodeId;
        // `node.frameId` on an <iframe> element is the frame it OWNS (its
        // content frame), which is exactly the frameId execution contexts are
        // tagged with via `auxData.frameId` — use it so `evaluate()` can find
        // the nested frame's own context instead of the OOPIF's top one.
        this.oopifFrameRootFrameId = desc.node.frameId ?? null;
        this.currentFrame = frameKey;
        this.refMap.clear();
        return true;
      }

      const frameId = desc.node.frameId;
      if (!frameId) {
        if (options.optional) return false;
        throw new ElementNotFoundError(selector);
      }
      // On failure `enterOopifFrame` returns false WITHOUT mutating
      // `currentFrameSession`, so we remain in the PARENT OOPIF. Do NOT silently
      // return false leaving the parent retargeted (M3): throw a clear error for
      // the non-optional case so the caller cannot mistake "still in parent" for
      // "descended into child".
      const entered = await this.enterOopifFrame(frameKey, frameId, options);
      if (!entered) {
        if (options.optional) return false;
        throw new Error(
          `Cannot descend into nested frame "${frameKey}": it is cross-origin from its ` +
            'parent frame but no child debugging session attached for it within the ' +
            `timeout (${Math.max(timeout, OOPIF_ATTACH_MIN_TIMEOUT_MS)}ms). It may still be ` +
            'loading, or auto-attach may be unavailable for it. The active frame is ' +
            'left unchanged at the parent; switchToMain() and restructure the flow if ' +
            'this persists.'
        );
      }
      return true;
    }

    // Initial iframe-element resolution. GUARDED with withStaleNodeRetry: on a
    // COLD start the cross-origin OOPIF commit fires `documentUpdated` on the
    // parent, which can stale the raw nodeId that findElement →
    // resolveRuntimeSelector's DOM.querySelector → DOM.describeNode({nodeId})
    // sequence uses, surfacing as an uncaught `CDPError: Could not find node with
    // given id`. The top-level click/fill/type paths already wrap their
    // resolution the same way; switchToFrame's initial resolve was the one
    // unguarded path (the later describeFrameElement is already guarded, but runs
    // AFTER this). On a stale-node error the retry resets rootNodeId (a stale node
    // implies the doc updated) so findElement re-resolves against a FRESH document.
    // A genuinely-absent iframe returns null (not a stale-node error), so it does
    // not retry and still falls through to the normal ElementNotFoundError below —
    // no infinite loop, no misleading message. Same-origin/top-level behaviour is
    // unchanged (findElement already ran there; it is only wrapped now).
    const element = await this.withStaleNodeRetry(() => this.findElement(selector, options));
    if (!element) {
      if (options.optional) return false;
      throw new ElementNotFoundError(selector);
    }

    // Resolve the iframe's frameId + same-session contentDocument via the STABLE
    // objectId path, GUARDED so a stale-nodeId CDPError from a mid-load
    // `documentUpdated` is retried (the element is re-resolved) rather than
    // propagating raw. `contentNodeId` is undefined for a cross-origin (OOPIF)
    // frame whose document is unreachable from this session.
    //
    // CRITICAL: classify same-origin vs cross-origin by the CHILD SESSION, not by
    // `contentDocument`. On a genuine OOPIF, `DOM.describeNode` transiently
    // returns a NON-NULL contentDocument during the brief window before the
    // cross-origin document commits to its own renderer; keying off it takes the
    // same-origin branch, fails to get an execution context, and would return
    // `true` with `currentFrameSession=null` — the silent mis-resolution bug.
    const { frameId, contentNodeId } = await this.describeFrameElement(selector, element, options);

    // AUTHORITATIVE OOPIF entry: a cross-origin child session already attached for
    // this frameId (even when contentDocument was transiently non-null). No wait
    // here, so a same-origin frame never pays for this probe.
    if (frameId && this.hasLiveOopifSession(frameId)) {
      if (await this.enterOopifFrame(frameKey, frameId, options)) {
        return true;
      }
    }

    if (contentNodeId === undefined) {
      // Cross-origin (OOPIF): the content document is not reachable from this
      // session. Descend into its auto-attached child session (bounded wait).
      if (frameId && (await this.enterOopifFrame(frameKey, frameId, options))) {
        return true;
      }
      if (options.optional) return false;
      // Distinguish the two real causes (L3): a frameId means this IS a
      // cross-origin frame whose child debugging session did not attach within
      // the timeout; no frameId means the content is unreachable for another
      // reason (sandboxed / detached).
      // Effective wait matches enterOopifFrame's floored timeout (M4).
      const timeout = Math.max(options.timeout ?? DEFAULT_TIMEOUT, OOPIF_ATTACH_MIN_TIMEOUT_MS);
      if (frameId) {
        throw new Error(
          `Cross-origin iframe "${frameKey}" did not attach a child debugging ` +
            `session within ${timeout}ms. It may still be loading, may be blocked ` +
            'by the browser, or auto-attach may be unavailable. Increase the ' +
            'timeout or verify the frame loads.'
        );
      }
      throw new Error(
        `Cannot access iframe content for "${frameKey}": its content document is ` +
          'unreachable and no frameId was resolved (sandboxed or detached frame).'
      );
    }

    // contentDocument is reachable: EITHER a genuine same-origin frame OR a
    // genuine OOPIF caught mid-commit (transient non-null contentDocument before
    // its cross-origin renderer attaches). Take the same-origin path, but never
    // finish in the silent "broken, no session" state for a cross-origin frame.
    this.frameContexts.set(frameKey, contentNodeId);
    this.currentFrame = frameKey;
    this.rootNodeId = contentNodeId;

    if (frameId) {
      const { timeout = DEFAULT_TIMEOUT } = options;

      // Wait for the same-origin execution context via event (unchanged fast path).
      let contextId = this.frameExecutionContexts.get(frameId);
      if (!contextId) {
        contextId = await this.waitForFrameContext(frameId, Math.min(timeout, 2000));
      }

      if (contextId) {
        // Same-origin frame with a live execution context: behaviour unchanged.
        this.currentFrameContextId = contextId;
        this.brokenFrame = null;
      } else {
        // No same-origin execution context. This is the OOPIF race window: do NOT
        // declare the frame "broken" and return true — that silently routes
        // subsequent actions to the PARENT look-alike. Poll for the cross-origin
        // child session up to the caller's timeout; if it attaches, enter the
        // OOPIF authoritatively (currentFrameSession set).
        const record = await this.waitForOopifSession(frameId, timeout);
        if (record && (await this.enterOopifFrame(frameKey, frameId, options))) {
          return true;
        }

        // No child session attached within the timeout. Distinguish a genuine
        // same-origin frame that merely lacks a JS context (e.g. a sandboxed
        // iframe — DOM still reachable via the parent session; keep the historical
        // brokenFrame behaviour) from a cross-origin frame that committed to its
        // own renderer and never attached (contentDocument now UNREACHABLE — must
        // not succeed silently as a broken parent-resolving frame).
        const recheck = await this.describeFrameElement(selector, element, options).catch(
          () => ({ frameId: undefined, contentNodeId: undefined }) as ReturnFrameDescribe
        );
        if (recheck.contentNodeId !== undefined) {
          // Still same-origin (reachable): preserve the historical broken-frame
          // behaviour so DOM operations can still work via CDP.
          this.brokenFrame = frameKey;
          console.warn(
            `[browser-pilot] Frame "${frameKey}" execution context unavailable. ` +
              'JS evaluation will fail in this frame. DOM operations may still work.'
          );
        } else {
          // Cross-origin frame that committed to its own renderer without
          // attaching a session — never leave the caller "in" a frame it cannot
          // safely act on (that is the silent mis-resolution bug).
          this.currentFrame = null;
          this.rootNodeId = null;
          this.frameContexts.delete(frameKey);
          if (options.optional) return false;
          throw new Error(
            `cross-origin frame "${frameKey}" did not attach a session within ${timeout}ms`
          );
        }
      }
    }

    // Clear ref map since we're in a new context
    this.refMap.clear();

    return true;
  }

  /**
   * Resolve an <iframe>/<frame> element's `frameId` and same-session
   * `contentDocument` nodeId via the STABLE objectId path (DOM.resolveNode →
   * DOM.describeNode {objectId}). GUARDED with {@link withStaleNodeRetry}: a raw
   * querySelector nodeId can be invalidated by a mid-load `documentUpdated`,
   * surfacing as an uncaught `CDPError: Could not find node with given id`; on
   * such an error the element is re-resolved and the describe is retried instead
   * of propagating raw. `contentNodeId` is `undefined` for a cross-origin (OOPIF)
   * frame whose document is not reachable from this (parent) session.
   */
  private async describeFrameElement(
    selector: string | string[],
    element: ElementInfo,
    options: ActionOptions
  ): Promise<ReturnFrameDescribe> {
    let el: ElementInfo = element;
    let reresolve = false;
    return this.withStaleNodeRetry(async () => {
      try {
        if (reresolve) {
          // A prior attempt hit a stale node; re-resolve the iframe element fresh.
          const fresh = await this.findElement(selector, options);
          if (fresh) el = fresh;
        }
        const objectId = await this.resolveObjectId(el.nodeId);
        const desc = await this.cdp.send<{
          node: { contentDocument?: { nodeId: number }; frameId?: string };
        }>('DOM.describeNode', { objectId, depth: 1 });
        return {
          frameId: desc.node.frameId,
          contentNodeId: desc.node.contentDocument?.nodeId,
        };
      } catch (e) {
        // Force a fresh element resolve if withStaleNodeRetry retries this fn.
        reresolve = true;
        throw e;
      }
    });
  }

  /**
   * True iff a cross-origin OOPIF child session is currently attached and live
   * for `frameId`. This is the AUTHORITATIVE cross-origin signal (not
   * `contentDocument`). Guarded so partial CDP mocks without `hasSession` degrade
   * to "no session" rather than throwing.
   */
  private hasLiveOopifSession(frameId: string): boolean {
    const record = this.oopifFrames.get(frameId);
    if (!record) return false;
    if (typeof this.cdp.hasSession !== 'function') return false;
    return this.cdp.hasSession(record.sessionId);
  }

  /**
   * Switch back to the main document from an iframe
   */
  async switchToMain(): Promise<void> {
    this.currentFrame = null;
    this.rootNodeId = null; // Will be re-fetched on next query
    this.currentFrameContextId = null;
    this.brokenFrame = null;
    // Leave any OOPIF child frame: subsequent actions route to the top session.
    this.currentFrameSession = null;
    this.oopifFrameRootNodeId = null;
    this.oopifFrameRootFrameId = null;
    this.refMap.clear();
  }

  /**
   * Get the current frame context (null = main frame)
   */
  getCurrentFrame(): string | null {
    return this.currentFrame;
  }

  /**
   * Reset ALL frame-scoping state back to the top-level document. Called on any
   * navigation (goto/reload/goBack/goForward) and on reset(): OOPIF child
   * sessions from the previous document detach, so leaving `currentFrameSession`
   * set would route subsequent actions to a dead child session (M1/M2). Also
   * prunes stale OOPIF registry entries so it can't grow unboundedly (M5).
   */
  private resetFrameState(): void {
    this.currentFrame = null;
    this.currentFrameContextId = null;
    this.frameContexts.clear();
    this.brokenFrame = null;
    this.currentFrameSession = null;
    this.oopifFrameRootNodeId = null;
    this.oopifFrameRootFrameId = null;
    this.pruneOopifFrames();
  }

  /**
   * Drop OOPIF registry entries whose child session is no longer live. Cheap and
   * idempotent; guarded so partial CDP mocks (unit tests) without `hasSession`
   * do not break.
   */
  private pruneOopifFrames(): void {
    if (typeof this.cdp.hasSession !== 'function') return;
    for (const [key, record] of this.oopifFrames) {
      if (!this.cdp.hasSession(record.sessionId)) {
        this.oopifFrames.delete(key);
      }
    }
  }

  /**
   * Forget a detached child session: remove any OOPIF registry entry bound to it
   * and, if it was the active frame session, drop back to the top-level document
   * so no further action targets the dead session. Wired to
   * `Target.detachedFromTarget` in {@link init}.
   */
  private dropOopifSession(sessionId: string): void {
    for (const [key, record] of this.oopifFrames) {
      if (record.sessionId === sessionId) this.oopifFrames.delete(key);
    }
    // Unsubscribe the per-session `Runtime.executionContextCreated` listener
    // registered in `handleTargetAttached`, or it leaks on the shared
    // connection for the lifetime of the underlying CDP client.
    const unsubscribe = this.oopifSessionUnsubscribers.get(sessionId);
    if (unsubscribe) {
      unsubscribe();
      this.oopifSessionUnsubscribers.delete(sessionId);
    }
    if (this.currentFrameSession === sessionId) {
      // The active frame's session died mid-interaction. A partial reset that
      // only cleared `currentFrameSession` would leave `rootNodeId`,
      // `currentFrame`, and `frameContexts` pointing at the dead child, so the
      // next action would resolve a child-session nodeId against the PARENT
      // session (wrong-node errors / acting on an unrelated element — BUG C).
      // Fall all the way back to the top-level document instead.
      this.rootNodeId = null;
      this.resetFrameState();
    }
  }

  /**
   * Reconcile the `oopifFrames` registry against targets that were ALREADY
   * attached (flatten:true) on this shared CDP connection before this page
   * armed `Target.setAutoAttach` (M4 daemon gap). Chrome only fires
   * `Target.attachedToTarget` for targets attached AFTER auto-attach is armed
   * (or newly created ones), so a daemon connection that kept an OOPIF child
   * session alive across CLI invocations would otherwise never be discovered.
   *
   * Related to THIS page: we cross-reference `Target.getTargets()`' iframe
   * targets against this page's own frame tree (`Page.getFrameTree`, which
   * lists OOPIF child frames as nodes even though their document lives out of
   * process) so we never claim another page's iframes. Best-effort: any
   * failure degrades to "nothing reconciled" (same as today, before this fix).
   */
  private async reconcileExistingOopifTargets(): Promise<void> {
    interface FrameTreeNode {
      frame: { id: string };
      childFrames?: FrameTreeNode[];
    }
    if (typeof this.cdp.attachToTarget !== 'function') return;
    try {
      const [targetsRes, frameTreeRes] = await Promise.all([
        this.cdp.send<{
          targetInfos: Array<{
            targetId: string;
            type: string;
            url: string;
            attached: boolean;
          }>;
        }>('Target.getTargets', undefined, this.cdp.sessionId),
        this.cdp
          .send<{ frameTree: FrameTreeNode }>('Page.getFrameTree', undefined, this.cdp.sessionId)
          .catch(() => null),
      ]);
      if (!frameTreeRes) return;

      const ownFrameIds = new Set<string>();
      const collectFrameIds = (node: FrameTreeNode): void => {
        ownFrameIds.add(node.frame.id);
        for (const child of node.childFrames ?? []) collectFrameIds(child);
      };
      collectFrameIds(frameTreeRes.frameTree);

      for (const info of targetsRes.targetInfos) {
        if (info.type !== 'iframe') continue;
        if (this.oopifFrames.has(info.targetId)) continue;
        // A cross-origin child frame's target id equals its frame id (verified
        // empirically elsewhere in this file); only claim ones in OUR tree.
        if (!ownFrameIds.has(info.targetId)) continue;
        try {
          const sessionId = info.attached
            ? await this.findExistingSessionForTarget(info.targetId)
            : await this.cdp.attachToTarget(info.targetId);
          if (!sessionId) continue;
          await this.handleTargetAttached({
            sessionId,
            targetInfo: { type: info.type, url: info.url, targetId: info.targetId },
            waitingForDebugger: false,
            parentSessionId: this.cdp.sessionId,
          });
        } catch {
          // Best-effort per-target; keep reconciling the rest.
        }
      }
    } catch {
      // Target.getTargets/getFrameTree unavailable (e.g. mocked CDP client in
      // unit tests) — degrade silently, same as before this fix.
    }
  }

  /**
   * A target reported `attached: true` by `Target.getTargets` already has a
   * live flat session somewhere on this connection, but `Target.getTargets`
   * does not tell us its sessionId. Re-attaching (flatten:true) to an already
   * attached target is a no-op from Chrome's perspective and returns the
   * SAME session id, so this is safe to call even though it looks redundant.
   */
  private async findExistingSessionForTarget(targetId: string): Promise<string | undefined> {
    try {
      return await this.cdp.attachToTarget(targetId);
    } catch {
      return undefined;
    }
  }

  /** True if `sessionId` is one of this page's own attached OOPIF child sessions. */
  private isKnownChildSession(sessionId: string): boolean {
    for (const record of this.oopifFrames.values()) {
      if (record.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * Hard-fail guard (C1) for element-acting/-reading methods that are NOT yet
   * routed into a cross-origin iframe (OOPIF) child session. Without this, while
   * `currentFrameSession` is set these methods resolve against the parent/default
   * session and silently act on a look-alike element — the exact
   * silent-mis-resolution bug OOPIF support exists to prevent. Supported in-frame
   * actions (fill/click/type/focus/press/text/waitFor/evaluate) route to the
   * child session before reaching any guarded path.
   */
  private assertOopifUnsupported(method: string): void {
    if (this.currentFrameSession !== null) {
      throw new Error(
        `${method} is not yet supported inside a cross-origin iframe ` +
          '(supported: fill, click, type, focus, press, text, waitFor, evaluate). ' +
          'Restructure the flow or switchToMain() first.'
      );
    }
  }

  // ============ Cross-origin (OOPIF) frame helpers ============
  //
  // These only run while an out-of-process iframe is the active frame
  // (`currentFrameSession !== null`). They deliberately AVOID synthetic-mouse
  // coordinate geometry (frame-offset translation is out of scope): fills use
  // focus + Input.insertText and clicks use element.click(), each routed to the
  // frame's own CDP child session. Top-level / same-origin paths are untouched.

  /**
   * Activate an OOPIF child frame identified by `frameId`. Waits (briefly) for
   * the auto-attached child session to appear, then routes subsequent frame
   * actions to it. Returns false when no child session materializes.
   */
  private async enterOopifFrame(
    frameKey: string,
    frameId: string,
    options: ActionOptions
  ): Promise<boolean> {
    // Honour the caller's timeout (M4): a `switchToFrame(sel, { timeout: 20000 })`
    // must wait up to 20s for the child session, not be silently truncated to 5s.
    // The floor only widens a very short caller timeout so auto-attach (async) has
    // a fair chance to land.
    const timeout = Math.max(options.timeout ?? DEFAULT_TIMEOUT, OOPIF_ATTACH_MIN_TIMEOUT_MS);
    const record = await this.waitForOopifSession(frameId, timeout);
    if (!record) return false;

    this.currentFrame = frameKey;
    this.currentFrameSession = record.sessionId;
    // OOPIF evaluation uses the child session's own default context, not a
    // numeric contextId on this page's session.
    this.currentFrameContextId = null;
    this.brokenFrame = null;
    // A freshly-entered OOPIF's query root is its own top-level document until
    // a same-origin nested iframe re-roots it (fix #2, see switchToFrame).
    this.oopifFrameRootNodeId = null;
    this.oopifFrameRootFrameId = null;
    this.refMap.clear();

    // Prime the child document so the first in-frame action doesn't race the
    // child's async load. Best-effort: actions poll for the node regardless.
    try {
      await this.ensureOopifRootReady(timeout);
    } catch {
      // The child is still loading; in-frame finders retry on their own.
    }
    return true;
  }

  /**
   * Poll the OOPIF registry for the child session bound to `frameId`, dropping
   * stale entries whose session is no longer live. Auto-attach is asynchronous,
   * so a freshly-navigated frame's session can arrive slightly after the parent
   * DOM exposes the iframe element.
   */
  private async waitForOopifSession(
    frameId: string,
    timeout: number
  ): Promise<{ sessionId: string; targetId: string; url: string } | null> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const record = this.oopifFrames.get(frameId);
      if (record) {
        if (this.cdp.hasSession(record.sessionId)) return record;
        // Session detached (e.g. reload); forget it and keep waiting for a fresh one.
        this.oopifFrames.delete(frameId);
      }
      if (Date.now() >= deadline) return null;
      await sleep(50);
    }
  }

  /**
   * Fetch (and cache) the document root nodeId inside the active OOPIF child
   * session, retrying while the child finishes loading.
   */
  private async ensureOopifRootReady(timeout: number): Promise<number> {
    const sessionId = this.currentFrameSession;
    if (!sessionId) throw new Error('No active OOPIF frame session');
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        const doc = await this.cdp.send<{ root: { nodeId: number } }>(
          'DOM.getDocument',
          { depth: 0 },
          sessionId
        );
        if (doc.root?.nodeId) {
          return doc.root.nodeId;
        }
      } catch {
        // DOM not ready yet on the child session.
      }
      if (Date.now() >= deadline) throw new Error('OOPIF document not ready');
      await sleep(50);
    }
  }

  /**
   * Resolve the DOM query ROOT nodeId to use for `sessionId`. When `sessionId`
   * is the currently active OOPIF child session AND `oopifFrameRootNodeId` is
   * set (fix #2: we descended into a SAME-ORIGIN iframe nested inside this
   * OOPIF), that nested document's nodeId is the root. Otherwise falls back to
   * the session's own top-level document (the common, non-nested case).
   */
  private async getOopifQueryRoot(sessionId: string): Promise<number | undefined> {
    if (sessionId === this.currentFrameSession && this.oopifFrameRootNodeId !== null) {
      return this.oopifFrameRootNodeId;
    }
    try {
      const doc = await this.cdp.send<{ root: { nodeId: number } }>(
        'DOM.getDocument',
        { depth: 0 },
        sessionId
      );
      return doc.root?.nodeId;
    } catch {
      return undefined;
    }
  }

  /**
   * Locate an element inside the active OOPIF child session and return both its
   * (child-session-scoped) nodeId and a Runtime objectId. Re-fetches the query
   * root (`getOopifQueryRoot`) each poll so a mid-load `documentUpdated` can't
   * leave us with a stale root. Supports plain CSS selectors and, as a
   * fallback, a shadow-DOM-piercing deep query. Queries are always rooted via
   * DOM-domain nodeId/objectId operations (never a bare `document.querySelector`
   * `Runtime.evaluate`), which is what lets this same code path reach into a
   * same-origin iframe nested inside the OOPIF (fix #2): the root's objectId is
   * bound to ITS OWN JS realm regardless of which frame is the session's
   * "default" execution context, so `Runtime.callFunctionOn(rootObjectId, ...)`
   * below runs `deepQuery`/`querySelector` in the correct document either way.
   */
  private async findElementInSession(
    selector: string | string[],
    sessionId: string,
    timeout: number
  ): Promise<{ nodeId: number; objectId: string; selector: string } | null> {
    const selectors = Array.isArray(selector) ? selector : [selector];
    const deadline = Date.now() + timeout;
    for (;;) {
      const root = await this.getOopifQueryRoot(sessionId);
      for (const sel of selectors) {
        try {
          if (root) {
            const q = await this.cdp.send<{ nodeId: number }>(
              'DOM.querySelector',
              { nodeId: root, selector: sel },
              sessionId
            );
            if (q.nodeId) {
              const resolved = await this.cdp.send<{ object: { objectId: string } }>(
                'DOM.resolveNode',
                { nodeId: q.nodeId },
                sessionId
              );
              return { nodeId: q.nodeId, objectId: resolved.object.objectId, selector: sel };
            }
          }
        } catch {
          // querySelector can throw for shadow-only matches or during load.
        }

        // Shadow-piercing fallback (L-1): `DOM.querySelector` above does NOT
        // pierce shadow roots, but the visibility probe (`waitForActionableInSession`)
        // proves visibility with a shadow-piercing `deepQuery`. Without this
        // fallback a shadow-encapsulated field in an OOPIF passes the visibility
        // probe then fails here with ElementNotFoundError. Resolve via the same
        // `deepQuery`, rooted at `root`'s own objectId (see doc comment above for
        // why this must be objectId-rooted rather than a bare global `document`),
        // then map the returned handle back to a nodeId.
        try {
          if (!root) continue;
          const rootObj = await this.cdp.send<{ object: { objectId: string } }>(
            'DOM.resolveNode',
            { nodeId: root },
            sessionId
          );
          const deep = await this.cdp.send<{ result: { objectId?: string } }>(
            'Runtime.callFunctionOn',
            {
              objectId: rootObj.object.objectId,
              functionDeclaration: `function(sel) { ${DEEP_QUERY_SCRIPT} return deepQuery(sel, this); }`,
              arguments: [{ value: sel }],
              returnByValue: false,
            },
            sessionId
          );
          const objectId = deep.result.objectId;
          if (objectId) {
            const req = await this.cdp.send<{ nodeId: number }>(
              'DOM.requestNode',
              { objectId },
              sessionId
            );
            if (req.nodeId) {
              return { nodeId: req.nodeId, objectId, selector: sel };
            }
          }
        } catch {
          // deepQuery/requestNode can throw during load; try the next candidate.
        }
      }
      if (Date.now() >= deadline) return null;
      await sleep(50);
    }
  }

  /**
   * Evaluate a `functionDeclaration(sel)` (given a selector string) against the
   * DOM query root for `sessionId` (see {@link getOopifQueryRoot}) via
   * `Runtime.callFunctionOn` on the root's own objectId, rather than a bare
   * `Runtime.evaluate("document...")` expression. This is what lets the OOPIF
   * in-frame probes reach into a same-origin iframe nested inside the OOPIF
   * (fix #2): the root objectId is bound to its OWN document/realm, so the
   * function body's `this` is always the correct document regardless of which
   * frame the session's default execution context points at. Returns
   * `undefined` if no root is available (e.g. the child document is not ready
   * yet) or the call throws (evaluated during load).
   */
  private async evalInOopifRoot<T>(
    sel: string,
    sessionId: string,
    functionDeclaration: string
  ): Promise<T | undefined> {
    const root = await this.getOopifQueryRoot(sessionId);
    if (!root) return undefined;
    try {
      const rootObj = await this.cdp.send<{ object: { objectId: string } }>(
        'DOM.resolveNode',
        { nodeId: root },
        sessionId
      );
      const res = await this.cdp.send<{ result: { value: T } }>(
        'Runtime.callFunctionOn',
        {
          objectId: rootObj.object.objectId,
          functionDeclaration,
          arguments: [{ value: sel }],
          returnByValue: true,
        },
        sessionId
      );
      return res.result.value;
    } catch {
      return undefined;
    }
  }

  /**
   * Poll for a selector (any of several) to reach `state` inside the active
   * OOPIF child session, evaluating the same visibility/attachment predicates
   * the top-level wait subsystem uses, but rooted via {@link evalInOopifRoot}
   * so it also works when the active OOPIF has a same-origin nested iframe
   * root (fix #2).
   */
  private async waitForSelectorInSession(
    selectors: string[],
    sessionId: string,
    state: 'visible' | 'hidden' | 'attached' | 'detached',
    timeout: number
  ): Promise<boolean> {
    const wantPresent = state === 'visible' || state === 'attached';
    const buildFn = (): string =>
      state === 'attached' || state === 'detached'
        ? `function(sel) { ${DEEP_QUERY_SCRIPT} return deepQuery(sel, this) !== null; }`
        : `function(sel) { ${DEEP_QUERY_SCRIPT} ${VISIBLE_PREDICATE_SCRIPT} return bpElementVisible(deepQuery(sel, this)); }`;

    const deadline = Date.now() + timeout;
    const fn = buildFn();
    for (;;) {
      for (const sel of selectors) {
        const present = (await this.evalInOopifRoot<boolean>(sel, sessionId, fn)) === true;
        if ((wantPresent && present) || (!wantPresent && !present)) return true;
      }
      if (Date.now() >= deadline) return false;
      await sleep(100);
    }
  }

  /**
   * Diagnostic variant of {@link waitForSelectorInSession} for `state ===
   * 'visible'` only: instead of a boolean, polls until an element EXISTS and
   * reports WHY it is/isn't actionable — distinguishing "never found in the
   * DOM" from "found but not visible", and naming the SPECIFIC failing check
   * (display / visibility / opacity / zero-size bounding box) instead of a
   * generic "Element not found". This is the error-quality half of fix #1:
   * `resolveActionableInSession` used to poll the plain boolean predicate and,
   * on timeout, always threw `ElementNotFoundError` — which is misleading when
   * the element exists but is merely `opacity:0` or has a collapsed bounding
   * box (common for secured/tokenized card-field widgets).
   *
   * `allowOpacityZero`: when true, an element failing ONLY the opacity check
   * is reported as PASSING (`ok: true`, with `relaxed: true` so callers can
   * still tell). Intended for fill/focus/type on focusable form inputs; NOT
   * used for click (kept strict — see {@link FOCUSABLE_INPUT_PREDICATE_SCRIPT}
   * doc comment for the rationale).
   */
  private async waitForActionableInSession(
    selectors: string[],
    sessionId: string,
    timeout: number,
    opts: { allowOpacityZero?: boolean } = {}
  ): Promise<
    | { ok: true; selector: string; relaxed: boolean }
    | { ok: false; found: false }
    | { ok: false; found: true; selector: string; reason: string }
  > {
    const allowOpacityZero = opts.allowOpacityZero === true;
    const fn = `function(sel) {
        ${DEEP_QUERY_SCRIPT}
        ${VISIBLE_REASON_PREDICATE_SCRIPT}
        ${FOCUSABLE_INPUT_PREDICATE_SCRIPT}
        const el = deepQuery(sel, this);
        if (!el) return { found: false };
        let reason = bpElementVisibleReason(el, { allowOpacityZero: false });
        if (reason === 'opacity:0' && ${allowOpacityZero ? 'true' : 'false'} && bpIsFocusableInput(el)) {
          // Re-evaluate the FULL predicate with opacity relaxed, so an
          // opacity:0 element that ALSO fails a later check (e.g. zero-size
          // bounding box) still fails overall (opacity is checked BEFORE
          // bbox in bpElementVisibleReason, so the first pass above cannot
          // see a bbox failure hiding behind it).
          const relaxedReason = bpElementVisibleReason(el, { allowOpacityZero: true });
          if (relaxedReason === null) {
            return { found: true, reason: null, relaxed: true };
          }
          return { found: true, reason: relaxedReason };
        }
        return { found: true, reason };
      }`;

    const deadline = Date.now() + timeout;
    let lastFound = false;
    let lastReason = 'unknown';
    for (;;) {
      for (const sel of selectors) {
        const result = await this.evalInOopifRoot<{
          found: boolean;
          reason?: string | null;
          relaxed?: boolean;
        }>(sel, sessionId, fn);
        if (!result) continue;
        const { found, reason, relaxed } = result;
        if (found && (reason === null || reason === undefined)) {
          return { ok: true, selector: sel, relaxed: relaxed === true };
        }
        if (found) {
          lastFound = true;
          lastReason = reason ?? 'unknown';
        }
      }
      if (Date.now() >= deadline) {
        return lastFound
          ? { ok: false, found: true, selector: selectors[0]!, reason: lastReason }
          : { ok: false, found: false };
      }
      await sleep(100);
    }
  }

  /**
   * Report whether an element inside a child session is disabled (native
   * `disabled`, an ancestor `fieldset[disabled]`, or `aria-disabled="true"`).
   * Best-effort: returns false if the probe fails.
   */
  private async isDisabledInSession(objectId: string, sessionId: string): Promise<boolean> {
    try {
      const res = await this.cdp.send<{ result: { value: boolean } }>(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: `function() {
            if (this.disabled === true) return true;
            if (typeof this.closest === 'function' && this.closest('fieldset[disabled]')) return true;
            var aria = this.getAttribute && this.getAttribute('aria-disabled');
            return aria === 'true';
          }`,
          returnByValue: true,
        },
        sessionId
      );
      return res.result.value === true;
    } catch {
      return false;
    }
  }

  /**
   * Locate an ACTIONABLE element inside the active OOPIF child session. Enforces
   * the same existence + visibility (and, unless `requireEnabled === false`,
   * enabled) safety the top-level fill/click apply via `ensureActionable` (H1):
   * `findElementInSession` alone only proves existence, so a hidden/disabled node
   * would otherwise be acted on. Returns null only when `optional` and the
   * element never became actionable; otherwise throws.
   */
  private async resolveActionableInSession(
    selector: string | string[],
    sessionId: string,
    timeout: number,
    opts: { optional?: boolean; requireEnabled?: boolean; allowOpacityZero?: boolean }
  ): Promise<{ nodeId: number; objectId: string; selector: string } | null> {
    const selectors = Array.isArray(selector) ? selector : [selector];

    // Existence + visibility, polled on the child session's own context. Uses
    // the diagnostic predicate (fix #1) so a timeout can distinguish "never
    // found" from "found but not visible" and name the failing check, instead
    // of always throwing a generic ElementNotFoundError.
    const status = await this.waitForActionableInSession(selectors, sessionId, timeout, {
      allowOpacityZero: opts.allowOpacityZero,
    });
    if (!status.ok) {
      if (opts.optional) return null;
      if (!status.found) {
        throw new ElementNotFoundError(selector);
      }
      throw new ActionabilityError(
        `Element ${JSON.stringify(status.selector)} exists inside the cross-origin ` +
          `iframe but is not actionable (failed visibility check: ${status.reason}). ` +
          'The element was found in the DOM but is not visible/interactable ' +
          '(e.g. hidden, zero-size, or off-screen).',
        'visible'
      );
    }

    const found = await this.findElementInSession(
      selector,
      sessionId,
      Math.min(timeout, OOPIF_ATTACH_MIN_TIMEOUT_MS)
    );
    if (!found) {
      if (opts.optional) return null;
      throw new ElementNotFoundError(selector);
    }

    if (
      opts.requireEnabled !== false &&
      (await this.isDisabledInSession(found.objectId, sessionId))
    ) {
      if (opts.optional) return null;
      throw new Error(
        `Element "${found.selector}" is disabled inside the cross-origin iframe and cannot be actioned.`
      );
    }
    return found;
  }

  /**
   * Fill an input inside the active OOPIF child session using focus +
   * Input.insertText, both routed to the child session (focus on the child
   * session is the load-bearing part). Coordinate geometry is intentionally
   * skipped for OOPIF frames.
   */
  private async fillInFrame(
    selector: string | string[],
    value: string,
    options: FillOptions,
    dispatch: ActionDispatch
  ): Promise<boolean> {
    const sessionId = this.currentFrameSession!;
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    // H1: enforce visible + enabled before acting (parity with top-level fill).
    // allowOpacityZero (fix #1): secured card-field widgets often style the
    // real input with opacity:0; an attached focusable input failing ONLY that
    // check should still be fillable.
    const found = await this.resolveActionableInSession(selector, sessionId, timeout, {
      optional: options.optional,
      allowOpacityZero: true,
    });
    if (!found) return false;
    this._lastMatchedSelector = found.selector;

    // Focus on the CHILD session, then select existing content so insertText
    // replaces it (matches the top-level fill's clear-then-type semantics).
    await this.cdp.send('DOM.focus', { nodeId: found.nodeId }, sessionId);
    await this.selectEditableContent(found.objectId, sessionId);

    if (value === '') {
      await dispatch.send(
        () =>
          this.cdp.send(
            'Runtime.callFunctionOn',
            {
              objectId: found.objectId,
              functionDeclaration: `function() {
                if (this.isContentEditable) { this.textContent = ''; }
                else { this.value = ''; }
                this.dispatchEvent(new Event('input', { bubbles: true }));
                this.dispatchEvent(new Event('change', { bubbles: true }));
              }`,
            },
            sessionId
          ),
        'fillValue'
      );
    } else {
      await dispatch.send(
        () => this.cdp.send('Input.insertText', { text: value }, sessionId),
        'insertText'
      );
    }

    if (options.verify !== false) {
      const verifyMode = options.verify === 'normalized' ? 'normalized' : 'exact';
      const actual = await this.readEditableValue(found.objectId, sessionId);
      const matches =
        verifyMode === 'normalized' ? fillValuesMatchNormalized(value, actual) : actual === value;
      if (!matches) {
        if (options.optional) return false;
        throw new Error(
          `Fill value did not stick. Expected ${JSON.stringify(value)} but got ${JSON.stringify(actual)}.`
        );
      }
    }

    if (options.blur) {
      await this.cdp.send(
        'Runtime.callFunctionOn',
        { objectId: found.objectId, functionDeclaration: 'function() { this.blur(); }' },
        sessionId
      );
    }
    return true;
  }

  /**
   * Click an element inside the active OOPIF child session via element.click()
   * (JS click; synthetic-mouse coordinate translation is out of scope). Runs a
   * round-trip afterwards so synchronous handlers complete before returning.
   */
  private async clickInFrame(
    selector: string | string[],
    options: ActionOptions,
    dispatch: ActionDispatch
  ): Promise<boolean> {
    const sessionId = this.currentFrameSession!;
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    // H1: enforce visible + enabled before acting (parity with top-level click).
    const found = await this.resolveActionableInSession(selector, sessionId, timeout, {
      optional: options.optional,
    });
    if (!found) return false;
    this._lastMatchedSelector = found.selector;

    await this.cdp.send('DOM.focus', { nodeId: found.nodeId }, sessionId).catch(() => {});
    await dispatch.send(
      () =>
        this.cdp.send(
          'Runtime.callFunctionOn',
          { objectId: found.objectId, functionDeclaration: 'function() { this.click(); }' },
          sessionId
        ),
      'javascriptClick'
    );
    return true;
  }

  /**
   * Type into a field inside the active OOPIF child session: focus on the child
   * session, then per-character key events (or `Input.insertText` for chars with
   * no US-layout mapping) dispatched on the child session. Enforces visible +
   * enabled first (H1). Mirrors the top-level {@link type} keystroke path.
   */
  private async typeInFrame(
    selector: string | string[],
    text: string,
    options: TypeOptions,
    dispatch: ActionDispatch
  ): Promise<boolean> {
    const sessionId = this.currentFrameSession!;
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const { delay = 50 } = options;
    // allowOpacityZero (fix #1): see fillInFrame's comment; type() has the
    // same secured-field rationale.
    const found = await this.resolveActionableInSession(selector, sessionId, timeout, {
      optional: options.optional,
      allowOpacityZero: true,
    });
    if (!found) return false;
    this._lastMatchedSelector = found.selector;

    await this.cdp.send('DOM.focus', { nodeId: found.nodeId }, sessionId);
    const beforeState = await this.readEditableState(found.objectId, sessionId);

    for (const char of text) {
      const def = US_KEYBOARD[char];
      if (def) {
        await this.dispatchKeyDefinition(def, 0, sessionId, dispatch);
      } else {
        // Non-layout character (emoji, CJK): use insertText on the child session.
        await dispatch.send(
          () => this.cdp.send('Input.insertText', { text: char }, sessionId),
          'insertText'
        );
      }
      if (delay > 0) {
        await sleep(delay);
      }
    }

    const afterState = await this.readEditableState(found.objectId, sessionId);
    if (
      text.length > 0 &&
      beforeState.value === afterState.value &&
      beforeState.selectionStart === afterState.selectionStart &&
      beforeState.selectionEnd === afterState.selectionEnd
    ) {
      await dispatch.send(
        () => this.cdp.send('Input.insertText', { text }, sessionId),
        'insertText'
      );
    }

    if (options.blur) {
      await this.cdp.send(
        'Runtime.callFunctionOn',
        { objectId: found.objectId, functionDeclaration: 'function() { this.blur(); }' },
        sessionId
      );
    }
    return true;
  }

  /**
   * Focus an element inside the active OOPIF child session (H1: existence +
   * visibility enforced; a disabled element can still be focused, so enabled is
   * not required here). `DOM.focus` is routed to the child session.
   */
  private async focusInFrame(
    selector: string | string[],
    options: ActionOptions
  ): Promise<boolean> {
    const sessionId = this.currentFrameSession!;
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    // allowOpacityZero (fix #1): focus, like fill/type, must reach
    // opacity:0-styled secured inputs.
    const found = await this.resolveActionableInSession(selector, sessionId, timeout, {
      optional: options.optional,
      requireEnabled: false,
      allowOpacityZero: true,
    });
    if (!found) return false;
    this._lastMatchedSelector = found.selector;
    await this.cdp.send('DOM.focus', { nodeId: found.nodeId }, sessionId);
    return true;
  }

  /**
   * Read text content from within the active OOPIF child session.
   */
  private async textInFrame(selector: string | undefined): Promise<string> {
    const sessionId = this.currentFrameSession!;
    if (!selector) {
      const res = await this.cdp.send<{ result: { value: string } }>(
        'Runtime.evaluate',
        { expression: 'document.body.innerText', returnByValue: true },
        sessionId
      );
      return res.result.value ?? '';
    }
    const found = await this.findElementInSession(selector, sessionId, DEFAULT_TIMEOUT);
    if (!found) return '';
    const res = await this.cdp.send<{ result: { value: string } }>(
      'Runtime.callFunctionOn',
      {
        objectId: found.objectId,
        functionDeclaration: 'function() { return this.innerText || this.textContent || ""; }',
        returnByValue: true,
      },
      sessionId
    );
    return res.result.value ?? '';
  }

  /**
   * Diagnose whether a CSS selector resolves inside an iframe rather than the
   * current (main) document. `snapshot()` and CSS-based fills/waits do NOT
   * pierce iframes, so a selector whose only true match lives inside an iframe
   * `contentDocument` will silently fail (or, worse, resolve a look-alike
   * parent element). This is a best-effort, on-demand check intended for the
   * failure / not-found path — it runs a single in-page `Runtime.evaluate` and
   * does not touch the happy path.
   *
   * Returns:
   * - `'main'`   — the selector matches in the current document.
   * - `'iframe'` — it matches only inside a same-origin iframe; the caller
   *   should `switchToFrame(...)` before acting on it.
   * - `'none'`   — no match anywhere reachable (may still exist in a
   *   cross-origin iframe, which is not inspectable).
   *
   * @param selector - A plain CSS selector (ref:/text:/role: selectors are not
   *   iframe-scoped and always report against the current document).
   */
  async locateSelectorFrame(selector: string): Promise<'main' | 'iframe' | 'none'> {
    // L-2: inside a cross-origin (OOPIF) frame the default session evaluates
    // against the PARENT document and would mis-report. Route the probe to the
    // active child session so 'main' correctly means "the document you are
    // currently operating in" (the OOPIF child), not the parent. A numeric
    // contextId and a sessionId are mutually exclusive, so only send the contextId
    // on the default (non-OOPIF) session.
    const sessionId = this.currentFrameSession ?? undefined;
    try {
      const result = await this.cdp.send<{ result: RemoteObject }>(
        'Runtime.evaluate',
        {
          expression: `(() => {
          const sel = ${JSON.stringify(selector)};
          try { if (document.querySelector(sel)) return 'main'; } catch { return 'none'; }
          const frames = document.querySelectorAll('iframe, frame');
          for (const f of frames) {
            try {
              const doc = f.contentDocument;
              if (doc && doc.querySelector(sel)) return 'iframe';
            } catch { /* cross-origin: not inspectable */ }
          }
          return 'none';
        })()`,
          returnByValue: true,
          contextId: sessionId ? undefined : (this.currentFrameContextId ?? undefined),
        },
        sessionId
      );
      const value = result.result.value;
      return value === 'main' || value === 'iframe' ? value : 'none';
    } catch {
      return 'none';
    }
  }

  // ============ Waiting ============

  /**
   * Wait for an element to reach a state
   */
  async waitFor(selector: string | string[], options: WaitForOptions = {}): Promise<boolean> {
    const { timeout = DEFAULT_TIMEOUT, state = 'visible' } = options;
    const selectors = Array.isArray(selector) ? selector : [selector];

    // Cross-origin (OOPIF) frame active: poll the child session's own context.
    if (this.currentFrameSession) {
      const success = await this.waitForSelectorInSession(
        selectors,
        this.currentFrameSession,
        state,
        timeout
      );
      if (!success && !options.optional) {
        throw new TimeoutError(`Timeout waiting for ${selectors.join(' or ')} to be ${state}`);
      }
      return success;
    }

    const result = await waitForAnyElement(this.cdp, selectors, {
      state,
      timeout,
      contextId: this.currentFrameContextId ?? undefined,
    });

    if (!result.success && !options.optional) {
      throw new TimeoutError(`Timeout waiting for ${selectors.join(' or ')} to be ${state}`);
    }

    return result.success;
  }

  /**
   * Wait for application-level readiness after a navigation milestone.
   * Unlike element waits this deliberately keeps polling through an empty
   * first snapshot and through pages that continue making background requests.
   */
  async waitForReady(options: WaitForReadyOptions = {}): Promise<boolean> {
    this.assertOopifUnsupported('waitForReady');
    const result = await waitForReadyStrategy(this.cdp, {
      ...options,
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      contextId: this.currentFrameContextId ?? undefined,
      refMap: this.exportRefMap(),
    });
    const diagnostics: ReadinessDiagnostics = {
      ...(result.diagnostics ?? {
        ready: result.success,
        waitedMs: result.waitedMs,
        unmetConditions: [],
        checkedAt: new Date().toISOString(),
      }),
      ready: result.success,
      waitedMs: result.waitedMs,
      lastMilestone: this._lastNavigationMilestone,
    };
    this._lastReadinessDiagnostics = diagnostics;
    if (!result.success && !options.optional) {
      const unmet =
        diagnostics.unmetConditions.length > 0
          ? ` Unmet conditions: ${diagnostics.unmetConditions.join('; ')}.`
          : '';
      throw new TimeoutError(`Page readiness timeout after ${diagnostics.waitedMs}ms.${unmet}`);
    }
    return result.success;
  }

  /**
   * Wait for navigation to complete
   */
  async waitForNavigation(
    options: ActionOptions & { expectedUrl?: string } = {}
  ): Promise<boolean> {
    const { timeout = DEFAULT_TIMEOUT } = options;
    const result = await waitForNav(this.cdp, {
      timeout,
      waitUntil: options.waitUntil ?? 'load',
      expectedUrl: options.expectedUrl,
    });
    this._lastNavigationMilestone = result.milestone;

    if (!result.success && !options.optional) {
      throw new TimeoutError('Navigation timeout');
    }

    this.rootNodeId = null;
    this.refMap.clear();
    return result.success;
  }

  /**
   * Wait for network to be idle
   */
  async waitForNetworkIdle(options: NetworkIdleOptions = {}): Promise<boolean> {
    const { timeout = DEFAULT_TIMEOUT, idleTime = 500 } = options;
    const result = await waitForIdle(this.cdp, { timeout, idleTime });

    if (!result.success && !options.optional) {
      throw new TimeoutError('Network idle timeout');
    }

    return result.success;
  }

  // ============ JavaScript Execution ============

  /**
   * Evaluate JavaScript in the page context (or current frame context if in iframe)
   */
  async evaluate<T = unknown, Args extends unknown[] = unknown[]>(
    expression: string | ((...args: Args) => T),
    ...args: Args
  ): Promise<T> {
    let script: string;

    if (typeof expression === 'function') {
      const argString = args.map((a) => JSON.stringify(a)).join(', ');
      script = `(${expression.toString()})(${argString})`;
    } else {
      script = expression;
    }

    const params: Record<string, unknown> = {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    };

    // Cross-origin (OOPIF) frame active: evaluate in the child session's own
    // default context (no numeric contextId) UNLESS we're re-rooted onto a
    // same-origin nested iframe inside it (fix #2), in which case use THAT
    // frame's own execution context so `document`/globals resolve against the
    // nested document, not the OOPIF's top one. Otherwise use the same-origin
    // iframe execution context if we're in a (non-OOPIF) frame.
    const evalSessionId = this.currentFrameSession ?? undefined;
    if (evalSessionId !== undefined && this.oopifFrameRootFrameId) {
      const nestedContextId = this.oopifFrameExecutionContexts.get(this.oopifFrameRootFrameId);
      if (nestedContextId === undefined) {
        // We're re-rooted onto a same-origin nested iframe INSIDE this OOPIF
        // child session, but its execution context was never observed (e.g.
        // it hasn't been created yet, or was destroyed and pruned). Silently
        // falling back to the OOPIF's own top-level context would evaluate
        // `document.querySelector`/globals against the WRONG document — fail
        // loudly instead so callers don't get results from an unrelated frame.
        throw new Error(
          `Cannot evaluate: no execution context tracked for the current nested ` +
            `frame (frameId ${JSON.stringify(this.oopifFrameRootFrameId)}) inside the ` +
            'cross-origin iframe. The frame may not have finished loading yet, or its ' +
            'context was destroyed (e.g. by a reload).'
        );
      }
      params['contextId'] = nestedContextId;
    } else if (evalSessionId === undefined && this.currentFrameContextId !== null) {
      params['contextId'] = this.currentFrameContextId;
    }

    const result = await this.cdp.send<{
      result: RemoteObject;
      exceptionDetails?: ExceptionDetails;
    }>('Runtime.evaluate', params, evalSessionId);

    if (result.exceptionDetails) {
      throw new Error(this.formatEvaluationError(result.exceptionDetails));
    }

    return result.result.value as T;
  }

  // ============ Screenshots ============

  /**
   * Take a screenshot
   */
  async screenshot(
    options: { format?: 'png' | 'jpeg' | 'webp'; quality?: number; fullPage?: boolean } = {}
  ): Promise<string> {
    const { format = 'png', quality, fullPage = false } = options;

    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;

    if (fullPage) {
      // Get full page dimensions
      const metrics = await this.cdp.send<{
        contentSize: { width: number; height: number };
      }>('Page.getLayoutMetrics');

      clip = {
        x: 0,
        y: 0,
        width: metrics.contentSize.width,
        height: metrics.contentSize.height,
        scale: 1,
      };
    }

    const result = await this.cdp.send<{ data: string }>('Page.captureScreenshot', {
      format,
      quality: format === 'png' ? undefined : quality,
      clip,
      captureBeyondViewport: fullPage,
    });

    return result.data;
  }

  // ============ Text Extraction ============

  /**
   * Get text content from the page or a specific element
   */
  async text(selector?: string): Promise<string> {
    // Cross-origin (OOPIF) frame active: read from the child session.
    if (this.currentFrameSession) {
      return this.textInFrame(selector);
    }

    if (!selector) {
      const result = await this.evaluateInFrame<{ result: RemoteObject }>(
        'document.body.innerText'
      );
      return (result.result.value as string) ?? '';
    }

    return this.withStaleNodeRetry(async () => {
      const element = await this.findElement(selector, { timeout: DEFAULT_TIMEOUT });
      if (!element) return '';

      const objectId = await this.resolveObjectId(element.nodeId);
      const result = await this.cdp.send<{ result: { value: string } }>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function() { return this.innerText || this.textContent || ""; }',
        returnByValue: true,
      });

      return result.result.value ?? '';
    });
  }

  /**
   * Inspect the live-DOM state of an arbitrary selector — including
   * non-interactive elements (e.g. a `<div data-testid="toolbar">` container)
   * that `snapshot()` never surfaces, since that is built from the
   * accessibility tree and only enumerates interactive roles.
   *
   * Runs a single `Runtime.evaluate` round-trip that pierces shadow roots and
   * honors the current iframe context (like `waitFor`/`text`/`evaluate`). The
   * visibility test reuses the exact predicate the wait subsystem uses.
   *
   * Selector parity with `waitFor`: plain CSS selectors (attribute selectors
   * like `[data-testid='toolbar']`, `#id`, `.class`, descendant combinators)
   * and browser-pilot special selectors (`text:` / `role:`) are supported.
   * For special selectors the match is the single best element, so `count` is
   * 0 or 1.
   */
  async elementState(selector: string): Promise<ElementState> {
    this.assertOopifUnsupported('elementState');
    // Special selectors (text:/role:) resolve to the single best element and
    // must count hidden elements as "existing"; visibility is computed below.
    const specialLookup = buildSpecialSelectorLookupExpression(selector, { includeHidden: true });

    const matchesExpr = specialLookup
      ? `(() => { const bpEl = ${specialLookup}; return bpEl ? [bpEl] : []; })()`
      : `deepQueryAll(${JSON.stringify(selector)})`;

    const expression = `(() => {
      ${VISIBLE_PREDICATE_SCRIPT}
      function deepQueryAll(selector, root) {
        var node = root || document;
        var results = [];
        var seen = new Set();
        function collect(scope) {
          if (!scope || typeof scope.querySelectorAll !== 'function') return;
          var direct;
          try { direct = scope.querySelectorAll(selector); } catch (e) { return; }
          for (var i = 0; i < direct.length; i++) {
            if (!seen.has(direct[i])) { seen.add(direct[i]); results.push(direct[i]); }
          }
          var all = scope.querySelectorAll('*');
          for (var j = 0; j < all.length; j++) {
            if (all[j].shadowRoot) collect(all[j].shadowRoot);
          }
        }
        collect(node);
        return results;
      }
      var matches;
      try { matches = ${matchesExpr}; } catch (e) { matches = []; }
      if (!matches) matches = [];
      var count = matches.length;
      var first = count > 0 ? matches[0] : null;
      var text = '';
      if (first) {
        var raw = first.innerText != null ? first.innerText : (first.textContent != null ? first.textContent : '');
        text = String(raw).trim();
      }
      var value = null;
      if (
        first &&
        'value' in first &&
        typeof first.value === 'string' &&
        /^(INPUT|SELECT|TEXTAREA)$/.test(first.tagName)
      ) {
        value = first.value;
      }
      var boundingBox = null;
      if (first) {
        var rect = first.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          boundingBox = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
      }
      return {
        exists: count > 0,
        visible: first ? bpElementVisible(first) : false,
        count: count,
        text: text,
        value: value,
        boundingBox: boundingBox,
      };
    })()`;

    const result = await this.evaluateInFrame<{ result: { value: ElementState | undefined } }>(
      expression,
      { awaitPromise: true }
    );

    return (
      result.result.value ?? {
        exists: false,
        visible: false,
        count: 0,
        text: '',
        value: null,
        boundingBox: null,
      }
    );
  }

  /**
   * Enumerate form controls on the page with labels and current state.
   */
  async forms(): Promise<FormField[]> {
    this.assertOopifUnsupported('forms');
    const result = await this.evaluateInFrame<{ result: { value: FormField[] } }>(
      `(() => {
        function normalize(value) {
          return String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
        }

        function labelFor(el) {
          if (!el) return '';
          if (el.labels && el.labels.length) {
            return normalize(
              Array.from(el.labels)
                .map((label) => label.innerText || label.textContent || '')
                .join(' ')
            );
          }
          var ariaLabel = normalize(el.getAttribute && el.getAttribute('aria-label'));
          if (ariaLabel) return ariaLabel;
          if (el.id) {
            var byFor = document.querySelector('label[for="' + el.id.replace(/"/g, '\\\\"') + '"]');
            if (byFor) return normalize(byFor.innerText || byFor.textContent || '');
          }
          var closest = el.closest && el.closest('label');
          if (closest) return normalize(closest.innerText || closest.textContent || '');
          return '';
        }

        return Array.from(document.querySelectorAll('input, select, textarea')).map((el) => {
          var tag = el.tagName.toLowerCase();
          var type = tag === 'input' ? (el.type || 'text').toLowerCase() : tag;
          var value = null;

          if (tag === 'select') {
            value = el.multiple
              ? Array.from(el.selectedOptions).map((opt) => opt.value)
              : el.value || null;
          } else if (tag === 'textarea' || tag === 'input') {
            value = typeof el.value === 'string' ? el.value : null;
          }

          return {
            tag: tag,
            type: type,
            id: el.id || undefined,
            name: el.getAttribute('name') || undefined,
            value: value,
            checked: 'checked' in el ? !!el.checked : undefined,
            required: !!el.required,
            disabled: !!el.disabled,
            label: labelFor(el) || undefined,
            placeholder: normalize(el.getAttribute && el.getAttribute('placeholder')) || undefined,
            options:
              tag === 'select'
                ? Array.from(el.options).map((opt) => ({
                    value: opt.value || '',
                    text: normalize(opt.text || opt.label || ''),
                    selected: !!opt.selected,
                    disabled: !!opt.disabled,
                  }))
                : undefined,
          };
        });
      })()`
    );

    return result.result.value ?? [];
  }

  // ============ File Handling ============

  /**
   * Set files on a file input
   */
  async setInputFiles(
    selector: string | string[],
    files: FileInput[],
    options: ActionOptions = {}
  ): Promise<boolean> {
    this.assertOopifUnsupported('setInputFiles');
    return this.withStaleNodeRetry(async () => {
      const element = await this.findElement(selector, options);
      if (!element) {
        if (options.optional) return false;
        throw new ElementNotFoundError(selector);
      }

      // Convert files to the format CDP expects
      const fileData = await Promise.all(
        files.map(async (f) => {
          let base64: string;
          if (typeof f.buffer === 'string') {
            base64 = f.buffer;
          } else {
            const bytes = new Uint8Array(f.buffer);
            base64 = btoa(String.fromCharCode(...bytes));
          }
          return { name: f.name, mimeType: f.mimeType, data: base64 };
        })
      );

      const objectId = await this.resolveObjectId(element.nodeId);

      const result = await this.cdp.send<{
        result: { value: { ok: boolean; fileCount: number } };
      }>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(files) {
          if (!(this instanceof HTMLInputElement) || this.type !== 'file') {
            return { ok: false, fileCount: 0 };
          }

          const dt = new DataTransfer();
          for (const f of files) {
            const bytes = Uint8Array.from(atob(f.data), function(c) { return c.charCodeAt(0); });
            const file = new File([bytes], f.name, { type: f.mimeType });
            dt.items.add(file);
          }

          var descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
          if (descriptor && descriptor.set) {
            descriptor.set.call(this, dt.files);
          } else {
            this.files = dt.files;
          }

          this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          return {
            ok: (this.files && this.files.length === files.length) || files.length === 0,
            fileCount: this.files ? this.files.length : 0
          };
        }`,
        arguments: [{ value: fileData }],
        returnByValue: true,
      });

      if (!result.result.value.ok) {
        if (options.optional) return false;
        throw new Error('Failed to set files on input');
      }

      return true;
    });
  }

  private async getNativeSelectMetadata(
    objectId: string,
    targets: string[]
  ): Promise<{
    currentIndex: number;
    currentValue: string;
    disabled: string[];
    isSelect: boolean;
    missing: string[];
    multiple: boolean;
    options: Array<{ index: number; label: string; value: string }>;
    selectedValues: string[];
    targetIndexes: number[];
  }> {
    const result = await this.cdp.send<{
      result: {
        value: {
          currentIndex: number;
          currentValue: string;
          disabled: string[];
          isSelect: boolean;
          missing: string[];
          multiple: boolean;
          options: Array<{ index: number; label: string; value: string }>;
          selectedValues: string[];
          targetIndexes: number[];
        };
      };
    }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(targetValues) {
        if (!(this instanceof HTMLSelectElement)) {
          return {
            currentIndex: -1,
            currentValue: '',
            disabled: [],
            isSelect: false,
            missing: Array.isArray(targetValues) ? targetValues.map(String) : [],
            multiple: false,
            options: [],
            selectedValues: [],
            targetIndexes: []
          };
        }

        var allOptions = Array.from(this.options).map(function(opt, index) {
          return { index: index, label: opt.label || opt.text || '', value: opt.value || '' };
        });
        var targetIndexes = [];
        var missing = [];
        var disabled = [];

        for (var i = 0; i < targetValues.length; i++) {
          var target = String(targetValues[i]);
          var idx = -1;

          for (var j = 0; j < this.options.length; j++) {
            var opt = this.options[j];
            if (opt.value === target || opt.text === target || opt.label === target) {
              idx = j;
              break;
            }
          }

          if (idx === -1 && /^\\d+$/.test(target)) {
            var numericIndex = parseInt(target, 10);
            if (numericIndex >= 0 && numericIndex < this.options.length) {
              idx = numericIndex;
            }
          }

          if (idx === -1) {
            missing.push(target);
            continue;
          }

          if (this.options[idx] && this.options[idx].disabled) {
            disabled.push(target);
            continue;
          }

          if (targetIndexes.indexOf(idx) === -1) {
            targetIndexes.push(idx);
          }
        }

        return {
          currentIndex: this.selectedIndex,
          currentValue: this.value || '',
          disabled: disabled,
          isSelect: true,
          missing: missing,
          multiple: !!this.multiple,
          options: allOptions,
          selectedValues: Array.from(this.selectedOptions).map(function(opt) { return opt.value || ''; }),
          targetIndexes: targetIndexes
        };
      }`,
      arguments: [{ value: targets }],
      returnByValue: true,
    });

    return result.result.value;
  }

  private async readNativeSelectValues(objectId: string): Promise<string[]> {
    const result = await this.cdp.send<{ result: { value: string[] } }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration:
        'function() { return this instanceof HTMLSelectElement ? Array.from(this.selectedOptions).map(function(opt) { return opt.value || ""; }) : []; }',
      returnByValue: true,
    });
    return result.result.value ?? [];
  }

  private selectValuesMatch(actual: string[], expected: string[], multiple: boolean): boolean {
    if (!multiple) {
      return (actual[0] ?? '') === (expected[0] ?? '');
    }
    if (actual.length !== expected.length) {
      return false;
    }
    const actualSorted = [...actual].sort();
    const expectedSorted = [...expected].sort();
    return actualSorted.every((value, index) => value === expectedSorted[index]);
  }

  private async applyNativeSelectByKeyboard(
    nodeId: number,
    objectId: string,
    currentIndex: number,
    targetIndex: number,
    dispatch: ActionDispatch
  ): Promise<boolean> {
    await this.cdp.send('DOM.focus', { nodeId });

    if (targetIndex !== currentIndex) {
      let effectiveIndex = currentIndex;

      if (effectiveIndex < 0 || targetIndex < effectiveIndex) {
        await this.dispatchKey('Home', undefined, dispatch);
        effectiveIndex = 0;
      }
      const steps = targetIndex - effectiveIndex;
      const direction = steps >= 0 ? 'ArrowDown' : 'ArrowUp';

      for (let i = 0; i < Math.abs(steps); i++) {
        await this.dispatchKey(direction, undefined, dispatch);
      }
    }

    const selectedValues = await this.readNativeSelectValues(objectId);
    return selectedValues[0] !== undefined;
  }

  private async applyNativeSelectFallback(
    objectId: string,
    targetIndexes: number[],
    dispatch: ActionDispatch
  ): Promise<void> {
    await dispatch.send(
      () =>
        this.cdp.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function(indexes) {
            if (!(this instanceof HTMLSelectElement)) return false;

            var wanted = new Set(indexes.map(function(index) { return Number(index); }));
            for (var i = 0; i < this.options.length; i++) {
              this.options[i].selected = wanted.has(i);
            }
            if (!this.multiple && indexes.length === 1) {
              this.selectedIndex = indexes[0];
            }
            this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            return true;
          }`,
          arguments: [{ value: targetIndexes }],
          returnByValue: true,
        }),
      'selectValue'
    );
  }

  private async selectEditableContent(objectId: string, sessionId?: string): Promise<void> {
    await this.cdp.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function() {
        if (this.isContentEditable) {
          this.focus();
          const range = document.createRange();
          range.selectNodeContents(this);
          const selection = window.getSelection();
          if (selection) {
            selection.removeAllRanges();
            selection.addRange(range);
          }
          return;
        }

        if (this.tagName === 'TEXTAREA') {
          this.selectionStart = 0;
          this.selectionEnd = this.value.length;
          this.focus();
          return;
        }

        if (typeof this.select === 'function') {
          this.select();
        }
        this.focus();
      }`,
      },
      sessionId
    );
  }

  private async clearEditableSelection(
    objectId: string,
    key: 'Backspace' | 'Delete',
    dispatch: ActionDispatch
  ): Promise<void> {
    await this.selectEditableContent(objectId);
    await this.dispatchKey(key, undefined, dispatch);
  }

  private async readEditableValue(objectId: string, sessionId?: string): Promise<string> {
    const result = await this.cdp.send<{ result: { value: string } }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function() {
        if (this.isContentEditable) {
          return this.textContent || '';
        }
        return this.value || '';
      }`,
        returnByValue: true,
      },
      sessionId
    );
    return result.result.value ?? '';
  }

  private async readEditableState(
    objectId: string,
    sessionId?: string
  ): Promise<{ value: string; selectionStart: number | null; selectionEnd: number | null }> {
    const result = await this.cdp.send<{
      result: {
        value: { value: string; selectionStart: number | null; selectionEnd: number | null };
      };
    }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function() {
          return {
            value: this.isContentEditable ? (this.textContent || '') : (this.value || ''),
            selectionStart: typeof this.selectionStart === 'number' ? this.selectionStart : null,
            selectionEnd: typeof this.selectionEnd === 'number' ? this.selectionEnd : null,
          };
        }`,
        returnByValue: true,
      },
      sessionId
    );
    return (
      result.result.value ?? {
        value: '',
        selectionStart: null,
        selectionEnd: null,
      }
    );
  }

  private async selectAllActiveEditable(sessionId?: string): Promise<boolean> {
    const params: Record<string, unknown> = {
      expression: `(() => {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
          active.select();
          return true;
        }
        if (active instanceof HTMLElement && active.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(active);
          const selection = window.getSelection();
          if (!selection) return false;
          selection.removeAllRanges();
          selection.addRange(range);
          return true;
        }
        return false;
      })()`,
      returnByValue: true,
    };
    if (sessionId === undefined && this.currentFrameContextId !== null) {
      params['contextId'] = this.currentFrameContextId;
    }

    try {
      const result = await this.cdp.send<{ result: { value: boolean } }>(
        'Runtime.evaluate',
        params,
        sessionId
      );
      return result.result.value === true;
    } catch {
      return false;
    }
  }

  private async typeEditableFallback(
    nodeId: number,
    objectId: string,
    value: string,
    dispatch: ActionDispatch
  ): Promise<void> {
    await this.selectEditableContent(objectId);
    await this.cdp.send('DOM.focus', { nodeId });
    for (const char of value) {
      await this.dispatchKey(char, undefined, dispatch);
    }
  }

  private async applyRecordedSelectFallback(
    objectId: string,
    targetIndexes: number[],
    dispatch: ActionDispatch
  ): Promise<boolean> {
    await dispatch.send(
      () =>
        this.cdp.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function(indexes) {
            if (!(this instanceof HTMLSelectElement)) return false;

            var wanted = new Set(indexes.map(function(index) { return Number(index); }));
            for (var i = 0; i < this.options.length; i++) {
              this.options[i].selected = wanted.has(i);
            }
            if (!this.multiple && indexes.length === 1) {
              this.selectedIndex = indexes[0];
            }
            return true;
          }`,
          arguments: [{ value: targetIndexes }],
          returnByValue: true,
        }),
      'selectValue'
    );

    return this.invokeRecordedEventListeners(objectId, ['input', 'change'], dispatch);
  }

  private async invokeRecordedEventListeners(
    objectId: string,
    eventTypes: string[],
    dispatch?: ActionDispatch
  ): Promise<boolean> {
    const operation = () =>
      this.cdp.send<{ result: { value: boolean } }>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(types) {
        function buildPath(target) {
          var path = [];
          var node = target;

          while (node) {
            path.push(node);

            if (node.parentElement) {
              node = node.parentElement;
              continue;
            }

            if (node === document) {
              node = window;
              continue;
            }

            if (node.defaultView && node !== node.defaultView) {
              node = node.defaultView;
              continue;
            }

            if (node.ownerDocument && node !== node.ownerDocument) {
              node = node.ownerDocument;
              continue;
            }

            var root = node.getRootNode && node.getRootNode();
            if (root && root !== node && root.host) {
              node = root.host;
              continue;
            }

            node = null;
          }

          return path;
        }

        function createEvent(type, target, currentTarget, path, phase) {
          return {
            type: type,
            target: target,
            currentTarget: currentTarget,
            srcElement: target,
            isTrusted: true,
            bubbles: true,
            cancelable: true,
            composed: true,
            defaultPrevented: false,
            eventPhase: phase,
            timeStamp: Date.now(),
            preventDefault: function() {
              this.defaultPrevented = true;
            },
            stopPropagation: function() {
              this.__stopped = true;
            },
            stopImmediatePropagation: function() {
              this.__stopped = true;
              this.__immediateStopped = true;
            },
            composedPath: function() {
              return path.slice();
            }
          };
        }

        function invokePhase(type, nodes, capture, target, path) {
          var invoked = false;

          for (var i = 0; i < nodes.length; i++) {
            var currentTarget = nodes[i];

            var phase = currentTarget === target ? 2 : capture ? 1 : 3;

            // Invoke inline handler if present (e.g. onclick, oninput)
            var inlineHandler = currentTarget['on' + type];
            if (typeof inlineHandler === 'function') {
              var inlineEvent = createEvent(type, target, currentTarget, path, phase);
              inlineHandler.call(currentTarget, inlineEvent);
              invoked = true;
              if (inlineEvent.__stopped) break;
            }

            var store = currentTarget && currentTarget.__bpEventListeners;
            var entries = store && store[type];
            if (!Array.isArray(entries) || entries.length === 0) continue;

            var event = createEvent(type, target, currentTarget, path, phase);

            for (var j = 0; j < entries.length; j++) {
              var entry = entries[j];
              if (!!entry.capture !== capture) continue;

              var listener = entry.listener;
              if (typeof listener === 'function') {
                listener.call(currentTarget, event);
                invoked = true;
              } else if (listener && typeof listener.handleEvent === 'function') {
                listener.handleEvent(event);
                invoked = true;
              }

              if (event.__immediateStopped) {
                break;
              }
            }

            if (event.__stopped) {
              break;
            }
          }

          return invoked;
        }

        var path = buildPath(this);
        var capturePath = path.slice().reverse();
        var bubblePath = path.slice();
        var invokedAny = false;

        for (var i = 0; i < types.length; i++) {
          var type = String(types[i]);
          if (invokePhase(type, capturePath, true, this, path)) {
            invokedAny = true;
          }
          if (invokePhase(type, bubblePath, false, this, path)) {
            invokedAny = true;
          }
        }

        return invokedAny;
      }`,
        arguments: [{ value: eventTypes }],
        returnByValue: true,
      });
    const result = dispatch ? await dispatch.send(operation, 'selectEvents') : await operation();

    return result.result.value ?? false;
  }

  /**
   * Wait for a download to complete, triggered by an action
   */
  async waitForDownload(
    trigger: () => Promise<void>,
    options: ActionOptions = {}
  ): Promise<Download> {
    const { timeout = DEFAULT_TIMEOUT } = options;

    // Enable download events
    await this.cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      eventsEnabled: true,
    });

    return new Promise<Download>((resolve, reject) => {
      let downloadGuid: string | undefined;
      let suggestedFilename: string | undefined;
      let resolved = false;

      const timeoutTimer = setTimeout(() => {
        if (!resolved) {
          cleanup();
          reject(new TimeoutError(`Download timed out after ${timeout}ms`));
        }
      }, timeout);

      const onDownloadWillBegin = (params: Record<string, unknown>) => {
        downloadGuid = params['guid'] as string;
        suggestedFilename = params['suggestedFilename'] as string;
      };

      const onDownloadProgress = (params: Record<string, unknown>) => {
        if (params['guid'] === downloadGuid && params['state'] === 'completed') {
          resolved = true;
          cleanup();

          const download: Download = {
            filename: suggestedFilename ?? 'unknown',
            content: async () => {
              // In a full implementation, we'd read from the download path
              // For now, return empty ArrayBuffer
              return new ArrayBuffer(0);
            },
          };

          resolve(download);
        } else if (params['guid'] === downloadGuid && params['state'] === 'canceled') {
          resolved = true;
          cleanup();
          reject(new Error('Download was canceled'));
        }
      };

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        this.cdp.off('Browser.downloadWillBegin', onDownloadWillBegin);
        this.cdp.off('Browser.downloadProgress', onDownloadProgress);
      };

      this.cdp.on('Browser.downloadWillBegin', onDownloadWillBegin);
      this.cdp.on('Browser.downloadProgress', onDownloadProgress);

      // Execute the trigger action
      trigger().catch((err) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(err);
        }
      });
    });
  }

  // ============ Snapshot ============

  /**
   * Get an accessibility tree snapshot of the page
   */
  async snapshot(options: SnapshotOptions = {}): Promise<PageSnapshot> {
    this.assertOopifUnsupported('snapshot');
    const roleFilter = new Set((options.roles ?? []).map((role) => role.trim().toLowerCase()));
    // Fold url()+title() into a single Runtime.evaluate round-trip (one CDP
    // call instead of two) and fetch the AX tree in parallel.
    const [urlTitle, axTree] = await Promise.all([
      this.cdp.send<{ result: RemoteObject }>('Runtime.evaluate', {
        expression: '({ url: location.href, title: document.title })',
        returnByValue: true,
      }),
      this.cdp.send<{
        nodes: Array<{
          nodeId: string;
          ignored: boolean;
          role?: { value: string };
          name?: { value: string };
          value?: { value: unknown };
          parentId?: string;
          childIds?: string[];
          backendDOMNodeId?: number;
          properties?: Array<{ name: string; value: { value: unknown } }>;
        }>;
      }>('Accessibility.getFullAXTree'),
    ]);

    const urlTitleValue = (urlTitle.result.value ?? {}) as { url?: string; title?: string };
    const url = urlTitleValue.url ?? '';
    const title = urlTitleValue.title ?? '';

    // Process accessibility nodes
    const nodes = axTree.nodes.filter((n) => !n.ignored);
    const nodeMap = new Map(nodes.map((n) => [n.nodeId, n]));
    let refCounter = 0;
    const nodeRefs = new Map<string, string>();

    // Clear and repopulate the ref map for ref-based selectors
    this.refMap.clear();

    // Assign refs to nodes
    for (const node of nodes) {
      const ref = `e${++refCounter}`;
      nodeRefs.set(node.nodeId, ref);
      // Store mapping from ref to backendNodeId for ref-based selectors
      if (node.backendDOMNodeId !== undefined) {
        this.refMap.set(ref, node.backendDOMNodeId);
      }
    }

    // Build tree structure
    const buildNode = (nodeId: string): SnapshotNode | null => {
      const node = nodeMap.get(nodeId);
      if (!node) return null;

      const role = (node.role?.value ?? 'generic').toLowerCase();
      const name = node.name?.value;
      const value = node.value?.value;
      const ref = nodeRefs.get(nodeId)!;

      const children: SnapshotNode[] = [];
      if (node.childIds) {
        for (const childId of node.childIds) {
          const child = buildNode(childId);
          if (child) children.push(child);
        }
      }

      // Extract properties
      const disabled = node.properties?.find((p) => p.name === 'disabled')?.value.value as
        | boolean
        | undefined;
      const checked = normalizeAXCheckedValue(
        node.properties?.find((p) => p.name === 'checked')?.value.value
      );

      const properties = node.properties?.reduce<Record<string, unknown>>((acc, property) => {
        acc[property.name] = property.value.value;
        return acc;
      }, {});

      return {
        role,
        name,
        value: value !== undefined ? stringifyUnknown(value) : undefined,
        ref,
        children: children.length > 0 ? children : undefined,
        disabled,
        checked,
        ...(properties && Object.keys(properties).length > 0 ? { properties } : {}),
      };
    };

    // Find root nodes (nodes without parents that are in the list)
    const rootNodes = nodes.filter((n) => !n.parentId || !nodeMap.has(n.parentId));
    let accessibilityTree = rootNodes
      .map((n) => buildNode(n.nodeId))
      .filter((n): n is SnapshotNode => n !== null);

    if (roleFilter.size > 0) {
      const filteredAccessibilityTree: SnapshotNode[] = [];
      for (const node of nodes) {
        if (!roleFilter.has((node.role?.value ?? 'generic').toLowerCase())) {
          continue;
        }

        const snapshotNode = buildNode(node.nodeId);
        if (!snapshotNode) {
          continue;
        }

        filteredAccessibilityTree.push({
          ...snapshotNode,
          children: undefined,
        });
      }

      accessibilityTree = filteredAccessibilityTree;
    }

    // Extract interactive elements
    const interactiveRoles = new Set([
      'button',
      'link',
      'textbox',
      'checkbox',
      'radio',
      'combobox',
      'listbox',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'option',
      'searchbox',
      'slider',
      'spinbutton',
      'switch',
      'tab',
      'treeitem',
    ]);

    const interactiveElements: InteractiveElement[] = [];

    for (const node of nodes) {
      const role = (node.role?.value ?? '').toLowerCase();
      if (role && interactiveRoles.has(role) && (roleFilter.size === 0 || roleFilter.has(role))) {
        const ref = nodeRefs.get(node.nodeId)!;
        const name = (node.name?.value as string) ?? '';
        const disabled = node.properties?.find((p) => p.name === 'disabled')?.value.value as
          | boolean
          | undefined;
        const checked = normalizeAXCheckedValue(
          node.properties?.find((p) => p.name === 'checked')?.value.value
        );
        const value = node.value?.value;

        // Generate a selector based on backendDOMNodeId
        // This is a simplified approach - in production you'd want more robust selectors
        const selector = node.backendDOMNodeId
          ? `[data-backend-node-id="${node.backendDOMNodeId}"]`
          : `[aria-label="${name}"]`;

        interactiveElements.push({
          ref,
          role,
          name,
          selector,
          disabled,
          checked,
          value: value !== undefined ? stringifyUnknown(value) : undefined,
        });
      }
    }

    // Generate text representation
    const formatNode = (node: SnapshotNode, depth = 0): string => {
      let line = `${'  '.repeat(depth)}- ${node.role}`;
      if (node.name) line += ` "${node.name}"`;
      line += ` ref:${node.ref}`;
      if (node.disabled) line += ' (disabled)';
      if (node.checked !== undefined) line += node.checked ? ' (checked)' : ' (unchecked)';
      return line;
    };

    const formatTree = (nodes: SnapshotNode[], depth = 0): string => {
      const lines: string[] = [];
      for (const node of nodes) {
        lines.push(formatNode(node, depth));
        if (node.children) {
          lines.push(formatTree(node.children, depth + 1));
        }
      }
      return lines.join('\n');
    };

    // Lazily compute the (potentially large) text representation. Most callers
    // only read `accessibilityTree` / `interactiveElements`; building the full
    // formatted string on every snapshot is wasteful. The getter memoizes on
    // first access so repeated reads (and CLI commands that print `.text`) are
    // unaffected.
    let textCache: string | undefined;
    const computeText = (): string =>
      roleFilter.size > 0
        ? accessibilityTree.map((node) => formatNode(node)).join('\n')
        : formatTree(accessibilityTree);

    // Opt-in: enrich interactive elements with real DOM attributes via a
    // single batched pass (one DOM.getDocument flatten), NOT one CDP call
    // per node. Default-off so the cheap AX-only path is byte-for-byte
    // unchanged.
    if (options.attributes && interactiveElements.length > 0) {
      try {
        await this.enrichSnapshotAttributes(
          interactiveElements,
          nodeRefs,
          nodeMap,
          options.attributeNames
        );
      } catch {
        // Enrichment is best-effort; never fail the snapshot over it.
      }
    }

    const result: PageSnapshot = {
      url,
      title,
      timestamp: new Date().toISOString(),
      accessibilityTree,
      interactiveElements,
      get text(): string {
        if (textCache === undefined) textCache = computeText();
        return textCache;
      },
    };
    if (roleFilter.size === 0 && !options.attributes) {
      this.lastSnapshot = result; // Store for stale ref recovery
    }
    return result;
  }

  /** Attributes captured by the opt-in `snapshot({ attributes: true })` pass. */
  private static readonly ENRICHED_ATTRIBUTE_NAMES = [
    'id',
    'data-testid',
    'data-test',
    'data-test-id',
    'data-qa',
    'name',
    'type',
    'placeholder',
    'role',
    'aria-label',
  ];

  /**
   * Batched DOM-attribute enrichment for {@link snapshot} (opt-in).
   *
   * Performs ONE `DOM.getDocument` flatten (depth -1, pierce) to obtain every
   * node's `backendNodeId` + inline `attributes`, builds a
   * `backendNodeId -> Record<string,string>` map, and assigns the relevant
   * attributes (`id`, `data-testid`/`data-test`/`data-qa`, stable `class`es,
   * `name`, `type`, ...) onto each `InteractiveElement.attributes`.
   *
   * This is a single round-trip regardless of element count.
   */
  private async enrichSnapshotAttributes(
    interactiveElements: InteractiveElement[],
    nodeRefs: Map<string, string>,
    nodeMap: Map<string, { backendDOMNodeId?: number }>,
    extraAttributeNames?: string[]
  ): Promise<void> {
    // Build ref -> backendNodeId from the AX node map (the snapshot's source of truth).
    const refToBackendId = new Map<string, number>();
    for (const [nodeId, ref] of nodeRefs.entries()) {
      const backendId = nodeMap.get(nodeId)?.backendDOMNodeId;
      if (backendId !== undefined) refToBackendId.set(ref, backendId);
    }
    if (refToBackendId.size === 0) return;

    // ONE batched DOM read: full flattened document (incl. shadow/iframe piercing)
    // with inline attributes. Single round-trip regardless of element count.
    const doc = await this.cdp.send<{ root: FlatDomNode }>('DOM.getDocument', {
      depth: -1,
      pierce: true,
    });

    const wantedNames =
      extraAttributeNames && extraAttributeNames.length > 0
        ? [...Page.ENRICHED_ATTRIBUTE_NAMES, ...extraAttributeNames]
        : Page.ENRICHED_ATTRIBUTE_NAMES;
    const byBackendId = extractAttributesByBackendId(doc.root, wantedNames);

    for (const el of interactiveElements) {
      const backendId = refToBackendId.get(el.ref);
      if (backendId === undefined) continue;
      const attrs = byBackendId.get(backendId);
      if (attrs && Object.keys(attrs).length > 0) {
        el.attributes = attrs;
      }
    }
  }

  /**
   * Export the current ref map for cross-exec reuse (CLI).
   */
  exportRefMap(): Record<string, number> {
    const map: Record<string, number> = {};
    for (const [ref, backendNodeId] of this.refMap.entries()) {
      map[ref] = backendNodeId;
    }
    return map;
  }

  /**
   * Import a ref map previously captured from a snapshot.
   */
  importRefMap(refMap: Record<string, number>): void {
    this.refMap.clear();
    for (const [ref, backendNodeId] of Object.entries(refMap)) {
      if (typeof backendNodeId === 'number') {
        this.refMap.set(ref, backendNodeId);
      }
    }
  }

  // ============ Delta & Review ============

  /**
   * Capture current page state for delta comparison.
   * Call before an action, then call delta() again after and use computeDelta().
   */
  async captureState(): Promise<PageState> {
    const [url, title, snapshot, forms, text] = await Promise.all([
      this.url(),
      this.title(),
      this.snapshot(),
      this.forms(),
      this.text(),
    ]);
    return extractPageState(url, title, snapshot, forms, text);
  }

  /**
   * Compute what changed between two page states.
   * If no arguments: captures current state and returns it (for use as "before").
   * If one argument (before state): captures current state and computes delta.
   */
  async delta(before?: PageState): Promise<DeltaResult | PageState> {
    const currentState = await this.captureState();
    if (!before) return currentState;
    return computeDelta(before, currentState);
  }

  /**
   * Extract structured review surface from the current page.
   * Returns headings, form values, alerts, key-value pairs, tables, and status labels.
   */
  async review(): Promise<ReviewResult> {
    const [url, title, snapshot, forms, text] = await Promise.all([
      this.url(),
      this.title(),
      this.snapshot(),
      this.forms(),
      this.text(),
    ]);
    return extractReview(url, title, snapshot, forms, text);
  }

  // ============ Emit ============

  /**
   * Collect every CDP session belonging to this page that may own a WebSocket:
   * the page itself, its attached OOPIF sessions, and its dedicated workers.
   * Same-origin frames are found by the sweep itself, which walks `window`.
   */
  private async collectEmitRealms(): Promise<EmitRealm[]> {
    const realms: EmitRealm[] = [{ kind: 'main', label: 'main' }];

    for (const record of this.oopifFrames.values()) {
      realms.push({ kind: 'frame', sessionId: record.sessionId, label: `oopif:${record.url}` });
    }

    try {
      const { targetInfos } = await this.cdp.send<{
        targetInfos: Array<{ targetId: string; type: string; url: string; parentId?: string }>;
      }>('Target.getTargets');

      for (const info of targetInfos) {
        if (info.type !== 'worker' || info.parentId !== this._targetId) continue;

        // Reuse an existing session rather than attaching again on every emit.
        const cached = this.workerEmitSessions.get(info.targetId);
        if (cached && this.cdp.hasSession(cached)) {
          realms.push({ kind: 'worker', sessionId: cached, label: `worker:${info.url}` });
          continue;
        }

        const attached = await this.cdp.send<{ sessionId: string }>('Target.attachToTarget', {
          targetId: info.targetId,
          flatten: true,
        });
        this.workerEmitSessions.set(info.targetId, attached.sessionId);
        realms.push({
          kind: 'worker',
          sessionId: attached.sessionId,
          label: `worker:${info.url}`,
        });
      }
    } catch {
      // Workers are best-effort: a page without them is the common case.
    }

    return realms;
  }

  /**
   * List every live WebSocket this page can reach, across all realms.
   * Sends nothing - this is the dry run for {@link Page.emitMessage}.
   */
  async listMessageTargets(): Promise<SocketCandidate[]> {
    return listSockets(this.cdp, await this.collectEmitRealms());
  }

  /**
   * Send a message on a WebSocket the page itself opened, so it travels the
   * app's real connection. Never retried automatically: a dispatched frame is
   * an irreversible side effect on the server.
   */
  async emitMessage(payload: string, options?: EmitWsOptions): Promise<EmitResult> {
    return emitWsMessage(this.cdp, await this.collectEmitRealms(), payload, options);
  }

  // ============ Batch Execution ============

  /**
   * Execute a batch of steps
   */
  async batch(steps: Step[], options?: BatchOptions): Promise<BatchResult> {
    return this.batchExecutor.execute(steps, options);
  }

  // ============ Emulation ============

  /**
   * Set the viewport size and device metrics
   */
  async setViewport(options: ViewportOptions): Promise<void> {
    const {
      width,
      height,
      deviceScaleFactor = 1,
      isMobile = false,
      hasTouch = false,
      isLandscape = false,
    } = options;

    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile: isMobile,
      screenWidth: width,
      screenHeight: height,
      screenOrientation: {
        type: isLandscape ? 'landscapePrimary' : 'portraitPrimary',
        angle: isLandscape ? 90 : 0,
      },
    });

    if (hasTouch) {
      await this.cdp.send('Emulation.setTouchEmulationEnabled', {
        enabled: true,
        maxTouchPoints: 5,
      });
    }

    this.emulationState.viewport = options;
  }

  /**
   * Clear viewport override, return to default
   */
  async clearViewport(): Promise<void> {
    await this.cdp.send('Emulation.clearDeviceMetricsOverride');
    await this.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    this.emulationState.viewport = undefined;
  }

  /**
   * Set the user agent string and optional metadata
   */
  async setUserAgent(options: string | UserAgentOptions): Promise<void> {
    const opts: UserAgentOptions = typeof options === 'string' ? { userAgent: options } : options;

    await this.cdp.send('Emulation.setUserAgentOverride', {
      userAgent: opts.userAgent,
      acceptLanguage: opts.acceptLanguage,
      platform: opts.platform,
      userAgentMetadata: opts.userAgentMetadata,
    });

    this.emulationState.userAgent = opts;
  }

  /**
   * Set geolocation coordinates
   */
  async setGeolocation(options: GeolocationOptions): Promise<void> {
    const { latitude, longitude, accuracy = 1 } = options;

    // Grant geolocation permission first
    await this.cdp.send('Browser.grantPermissions', {
      permissions: ['geolocation'],
    });

    await this.cdp.send('Emulation.setGeolocationOverride', {
      latitude,
      longitude,
      accuracy,
    });

    this.emulationState.geolocation = options;
  }

  /**
   * Clear geolocation override
   */
  async clearGeolocation(): Promise<void> {
    await this.cdp.send('Emulation.clearGeolocationOverride');
    this.emulationState.geolocation = undefined;
  }

  /**
   * Set timezone override
   */
  async setTimezone(timezoneId: string): Promise<void> {
    await this.cdp.send('Emulation.setTimezoneOverride', { timezoneId });
    this.emulationState.timezone = timezoneId;
  }

  /**
   * Set locale override
   */
  async setLocale(locale: string): Promise<void> {
    await this.cdp.send('Emulation.setLocaleOverride', { locale });
    this.emulationState.locale = locale;
  }

  /**
   * Emulate a specific device
   */
  async emulate(device: DeviceDescriptor): Promise<void> {
    await this.setViewport(device.viewport);
    await this.setUserAgent(device.userAgent);
  }

  /**
   * Get current emulation state
   */
  getEmulationState(): EmulationState {
    return { ...this.emulationState };
  }

  // ============ Request Interception ============

  /**
   * Add request interception handler
   * @param pattern URL pattern or resource type to match
   * @param handler Handler function for matched requests
   * @returns Unsubscribe function
   */
  async intercept(pattern: string | RequestPattern, handler: RequestHandler): Promise<() => void> {
    // Lazy initialize interceptor
    if (!this.interceptor) {
      this.interceptor = new RequestInterceptor(this.cdp);
      await this.interceptor.enable();
    }

    const normalizedPattern: RequestPattern =
      typeof pattern === 'string' ? { urlPattern: pattern } : pattern;

    return this.interceptor.addHandler(normalizedPattern, handler);
  }

  /**
   * Route requests matching pattern to a mock response
   * Convenience wrapper around intercept()
   */
  async route(urlPattern: string, options: RouteOptions): Promise<() => void> {
    return this.intercept({ urlPattern }, async (_request, actions) => {
      let body = options.body;
      const headers = { ...options.headers };

      // Auto-serialize objects to JSON
      if (typeof body === 'object') {
        body = JSON.stringify(body);
        headers['content-type'] ??= 'application/json';
      }

      if (options.contentType) {
        headers['content-type'] = options.contentType;
      }

      await actions.fulfill({
        status: options.status ?? 200,
        headers,
        body: body as string,
      });
    });
  }

  /**
   * Block requests matching resource types
   */
  async blockResources(types: ResourceType[]): Promise<() => void> {
    return this.intercept({}, async (request, actions) => {
      if (types.includes(request.resourceType)) {
        await actions.fail({ reason: 'BlockedByClient' });
      } else {
        await actions.continue();
      }
    });
  }

  /**
   * Disable all request interception
   */
  async disableInterception(): Promise<void> {
    if (this.interceptor) {
      await this.interceptor.disable();
      this.interceptor = null;
    }
  }

  // ============ Cookies & Storage ============

  /**
   * Get all cookies for the current page
   */
  async cookies(urls?: string[]): Promise<Cookie[]> {
    const targetUrls = urls ?? [await this.url()];
    const result = await this.cdp.send<{ cookies: Cookie[] }>('Network.getCookies', {
      urls: targetUrls,
    });
    return result.cookies;
  }

  /**
   * Set a cookie
   */
  async setCookie(options: SetCookieOptions): Promise<boolean> {
    const { name, value, domain, path = '/', expires, httpOnly, secure, sameSite, url } = options;

    let expireTime: number | undefined;
    if (expires instanceof Date) {
      expireTime = Math.floor(expires.getTime() / 1000);
    } else if (typeof expires === 'number') {
      expireTime = expires;
    }

    const result = await this.cdp.send<{ success: boolean }>('Network.setCookie', {
      name,
      value,
      domain,
      path,
      expires: expireTime,
      httpOnly,
      secure,
      sameSite,
      url: url ?? (domain ? undefined : await this.url()),
    });

    return result.success;
  }

  /**
   * Set multiple cookies
   */
  async setCookies(cookies: SetCookieOptions[]): Promise<void> {
    for (const cookie of cookies) {
      await this.setCookie(cookie);
    }
  }

  /**
   * Set extra HTTP headers sent on every request from this page's CDP session.
   *
   * Unlike cookies, headers are per-CDP-session, not browser-wide, so this
   * must be reapplied on every new target/page if persistence is desired.
   */
  async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    await this.cdp.send('Network.setExtraHTTPHeaders', { headers });
  }

  /**
   * Delete a specific cookie
   */
  async deleteCookie(options: DeleteCookieOptions): Promise<void> {
    const { name, domain, path, url } = options;

    await this.cdp.send('Network.deleteCookies', {
      name,
      domain,
      path,
      url: url ?? (domain ? undefined : await this.url()),
    });
  }

  /**
   * Delete multiple cookies
   */
  async deleteCookies(cookies: DeleteCookieOptions[]): Promise<void> {
    for (const cookie of cookies) {
      await this.deleteCookie(cookie);
    }
  }

  /**
   * Clear all cookies
   */
  async clearCookies(options?: ClearCookiesOptions): Promise<void> {
    if (options?.domain) {
      // Get cookies for domain and delete them
      const domainCookies = await this.cookies([`https://${options.domain}`]);
      for (const cookie of domainCookies) {
        await this.deleteCookie({
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path,
        });
      }
    } else {
      // Clear all cookies via Storage domain
      await this.cdp.send('Storage.clearCookies', {});
    }
  }

  /**
   * Get localStorage value
   */
  async getLocalStorage(key: string): Promise<string | null> {
    const result = await this.cdp.send<{ result: { value: unknown } }>('Runtime.evaluate', {
      expression: `localStorage.getItem(${JSON.stringify(key)})`,
      returnByValue: true,
    });
    return result.result.value as string | null;
  }

  /**
   * Set localStorage value
   */
  async setLocalStorage(key: string, value: string): Promise<void> {
    await this.cdp.send('Runtime.evaluate', {
      expression: `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
    });
  }

  /**
   * Remove localStorage item
   */
  async removeLocalStorage(key: string): Promise<void> {
    await this.cdp.send('Runtime.evaluate', {
      expression: `localStorage.removeItem(${JSON.stringify(key)})`,
    });
  }

  /**
   * Clear localStorage
   */
  async clearLocalStorage(): Promise<void> {
    await this.cdp.send('Runtime.evaluate', {
      expression: 'localStorage.clear()',
    });
  }

  /**
   * Get sessionStorage value
   */
  async getSessionStorage(key: string): Promise<string | null> {
    const result = await this.cdp.send<{ result: { value: unknown } }>('Runtime.evaluate', {
      expression: `sessionStorage.getItem(${JSON.stringify(key)})`,
      returnByValue: true,
    });
    return result.result.value as string | null;
  }

  /**
   * Set sessionStorage value
   */
  async setSessionStorage(key: string, value: string): Promise<void> {
    await this.cdp.send('Runtime.evaluate', {
      expression: `sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
    });
  }

  /**
   * Remove sessionStorage item
   */
  async removeSessionStorage(key: string): Promise<void> {
    await this.cdp.send('Runtime.evaluate', {
      expression: `sessionStorage.removeItem(${JSON.stringify(key)})`,
    });
  }

  /**
   * Clear sessionStorage
   */
  async clearSessionStorage(): Promise<void> {
    await this.cdp.send('Runtime.evaluate', {
      expression: 'sessionStorage.clear()',
    });
  }

  // ============ Console & Errors ============

  /**
   * Enable console message capture
   */
  private async enableConsole(): Promise<void> {
    if (this.consoleEnabled) return;

    // Subscribe to console events (dialog listener is bound in constructor)
    this.cdp.on('Runtime.consoleAPICalled', this.handleConsoleMessage.bind(this));
    this.cdp.on('Runtime.exceptionThrown', this.handleException.bind(this));

    this.consoleEnabled = true;
  }

  /**
   * Handle console API calls
   */
  private handleConsoleMessage(params: Record<string, unknown>): void {
    const args = params['args'] as Array<{ value?: unknown; description?: string }> | undefined;
    const stackTrace = params['stackTrace'] as
      | {
          callFrames?: Array<{ url: string; lineNumber: number }>;
        }
      | undefined;

    const message: ConsoleMessage = {
      type: params['type'] as ConsoleMessageType,
      text: this.formatConsoleArgs(args ?? []),
      args: args?.map((a) => a.value) ?? [],
      timestamp: params['timestamp'] as number,
      stackTrace: stackTrace?.callFrames?.map((f) => `${f.url}:${f.lineNumber}`),
    };

    for (const handler of this.consoleHandlers) {
      try {
        handler(message);
      } catch (e) {
        console.error('[Console handler error]', e);
      }
    }
  }

  /**
   * Handle JavaScript exceptions
   */
  private handleException(params: Record<string, unknown>): void {
    const details = params['exceptionDetails'] as Record<string, unknown>;
    const exception = details['exception'] as { description?: string } | undefined;
    const stackTrace = details['stackTrace'] as
      | {
          callFrames?: Array<{ url: string; lineNumber: number }>;
        }
      | undefined;

    const error: PageError = {
      message: exception?.description ?? (details['text'] as string),
      url: details['url'] as string | undefined,
      lineNumber: details['lineNumber'] as number | undefined,
      columnNumber: details['columnNumber'] as number | undefined,
      timestamp: params['timestamp'] as number,
      stackTrace: stackTrace?.callFrames?.map((f) => `${f.url}:${f.lineNumber}`),
    };

    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch (e) {
        console.error('[Error handler error]', e);
      }
    }
  }

  /**
   * Handle dialog opening
   */
  private async handleDialogOpening(params: Record<string, unknown>): Promise<void> {
    const dialog: Dialog = {
      type: params['type'] as DialogType,
      message: params['message'] as string,
      defaultValue: params['defaultPrompt'] as string | undefined,
      accept: async (promptText?: string) => {
        await this.cdp.send('Page.handleJavaScriptDialog', {
          accept: true,
          promptText,
        });
      },
      dismiss: async () => {
        await this.cdp.send('Page.handleJavaScriptDialog', {
          accept: false,
        });
      },
    };

    if (this.dialogHandler) {
      const DIALOG_TIMEOUT = 5000;
      try {
        await Promise.race([
          this.dialogHandler(dialog),
          sleep(DIALOG_TIMEOUT).then(() => {
            console.warn('[browser-pilot] Dialog handler timed out after 5s, auto-dismissing');
            return dialog.dismiss();
          }),
        ]);
      } catch (e) {
        console.error('[Dialog handler error]', e);
        await dialog.dismiss();
      }
    } else {
      // Auto-dismiss by default
      await dialog.dismiss();
    }
  }

  /**
   * Format console arguments to string
   */
  private formatConsoleArgs(args: Array<{ value?: unknown; description?: string }>): string {
    return args
      .map((arg) => {
        if (arg.value !== undefined) return stringifyUnknown(arg.value);
        if (arg.description) return arg.description;
        return '[object]';
      })
      .join(' ');
  }

  /**
   * Subscribe to console messages
   */
  async onConsole(handler: ConsoleHandler): Promise<() => void> {
    await this.enableConsole();
    this.consoleHandlers.add(handler);
    return () => this.consoleHandlers.delete(handler);
  }

  /**
   * Subscribe to page errors
   */
  async onError(handler: ErrorHandler): Promise<() => void> {
    await this.enableConsole();
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  /**
   * Set dialog handler (only one at a time)
   */
  async onDialog(handler: DialogHandler | null): Promise<void> {
    await this.enableConsole();
    this.dialogHandler = handler;
  }

  /**
   * Collect console messages during an action
   */
  async collectConsole<T>(
    fn: () => Promise<T>
  ): Promise<{ result: T; messages: ConsoleMessage[] }> {
    const messages: ConsoleMessage[] = [];
    const unsubscribe = await this.onConsole((msg) => messages.push(msg));

    try {
      const result = await fn();
      return { result, messages };
    } finally {
      unsubscribe();
    }
  }

  /**
   * Collect errors during an action
   */
  async collectErrors<T>(fn: () => Promise<T>): Promise<{ result: T; errors: PageError[] }> {
    const errors: PageError[] = [];
    const unsubscribe = await this.onError((err) => errors.push(err));

    try {
      const result = await fn();
      return { result, errors };
    } finally {
      unsubscribe();
    }
  }

  // ============ Lifecycle ============

  /**
   * Reset page state for clean test isolation
   * - Stops any pending operations
   * - Clears localStorage and sessionStorage
   * - Resets internal state
   */
  async reset(): Promise<void> {
    // Reset internal state first
    this.rootNodeId = null;
    this.refMap.clear();
    this.currentFrame = null;
    this.currentFrameContextId = null;
    this.brokenFrame = null;
    this.frameContexts.clear();
    this.currentFrameSession = null;
    this.oopifFrameRootNodeId = null;
    this.oopifFrameRootFrameId = null;
    // Full teardown of the OOPIF registry (M5): a reset abandons the current
    // document, so no previously attached child session is relevant anymore.
    this.oopifFrames.clear();
    this.oopifFrameExecutionContexts.clear();
    this.dialogHandler = null;

    // Stop any pending loading
    try {
      await this.cdp.send('Page.stopLoading');
    } catch {
      // Ignore errors
    }

    // Clear storage without navigating (faster and more reliable)
    try {
      await this.cdp.send('Runtime.evaluate', {
        expression: `(() => {
          try { localStorage.clear(); } catch {}
          try { sessionStorage.clear(); } catch {}
        })()`,
      });
    } catch {
      // Ignore if storage clearing fails
    }
  }

  /**
   * Release connection-global listeners this Page installed. Idempotent.
   *
   * The OOPIF firehose handler (`onAny`) is registered on the shared connection,
   * not scoped to this page, so a discarded Page without teardown would keep
   * processing every target attach/detach on the connection forever (BUG A).
   * Called by {@link Browser.closePage} and {@link close}.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.oopifAnyHandler && typeof this.cdp.offAny === 'function') {
      this.cdp.offAny(this.oopifAnyHandler);
    }
    this.oopifAnyHandler = null;
    // Release every per-session `Runtime.executionContextCreated` listener
    // registered by `handleTargetAttached` (same connection-global leak
    // concern as `oopifAnyHandler` above, one entry per attached child session).
    for (const unsubscribe of this.oopifSessionUnsubscribers.values()) {
      unsubscribe();
    }
    this.oopifSessionUnsubscribers.clear();
  }

  /**
   * Close this page. Target teardown is managed by {@link Browser.closePage};
   * this releases the page's connection-global listeners so a closed Page stops
   * reacting to target lifecycle events.
   */
  async close(): Promise<void> {
    this.dispose();
  }

  // ============ Resolution & Diagnostics ============

  /**
   * Score every plausible target for `intent` and return the ranked candidates.
   *
   * Takes ONE snapshot (reusing `opts.snapshot` when provided, otherwise an
   * attribute-enriched snapshot so testid/css strategies have real DOM hooks),
   * then delegates all scoring to {@link rankCandidates}. This is read-only:
   * it EXECUTES NOTHING — no clicks, no navigation — it only ranks.
   */
  async resolveAll(
    intent: string,
    opts: {
      snapshot?: PageSnapshot;
      action?: string;
      limit?: number;
      includeHidden?: boolean;
      strategies?: CandidateStrategy[];
      minConfidence?: number;
      /**
       * Extra DOM attribute names the ranker may use as deterministic hooks
       * (extends the default data-testid/data-test/data-qa set). When a fresh
       * snapshot is taken here it is enriched with these attributes too, so a
       * unique value like `data-cmd="c2"` becomes a `[data-cmd="c2"]` candidate.
       */
      testIdAttributes?: string[];
    } = {}
  ): Promise<RankedCandidate[]> {
    const snapshot =
      opts.snapshot ??
      (await this.snapshot({ attributes: true, attributeNames: opts.testIdAttributes }));
    return rankCandidates(snapshot, intent, {
      actionType: opts.action,
      maxResults: opts.limit,
      strategies: opts.strategies,
      minConfidence: opts.minConfidence,
      testIdAttributes: opts.testIdAttributes,
      returnAll: true,
    });
  }

  /**
   * Diagnose why a selector or intent does/doesn't resolve to an element.
   * Thin delegation to {@link diagnoseElement}.
   */
  async diagnose(selectorOrIntent: string, opts?: DiagnoseOptions): Promise<DiagnoseResult> {
    // L-2: diagnostics resolve against the DEFAULT session (snapshot, AX tree,
    // querySelector), so inside a cross-origin (OOPIF) frame they would report
    // about the PARENT document, not the frame the caller is operating in.
    // Read-only, so no C1 risk, but misleading — fail with a clear message rather
    // than silently diagnosing the wrong document. (snapshot() also guards this,
    // but naming `diagnose` gives a clearer error.)
    this.assertOopifUnsupported('diagnose');
    return diagnoseElement(this, selectorOrIntent, opts);
  }

  // ============ Private Helpers ============

  /**
   * Retry wrapper for operations that may encounter stale nodes
   * Catches "Could not find node with given id" errors and retries
   */
  private async withStaleNodeRetry<T>(
    fn: () => Promise<T>,
    options: { retries?: number; delay?: number; dispatch?: ActionDispatch } = {}
  ): Promise<T> {
    const { retries = 2, delay = 50 } = options;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (options.dispatch?.hasPotentiallyDispatched) {
          throw e;
        }
        const stale = classifyStaleError(e);
        if (stale.stale) {
          lastError = e instanceof Error ? e : new Error(String(e));
          if (attempt < retries) {
            // Reset every resolution cache so the next attempt uses fresh DOM,
            // frame, ref, and execution-context handles. Keep lastSnapshot so
            // semantic recovery can compare the old and new trees.
            this.rootNodeId = null;
            this.currentFrameContextId = null;
            this.frameContexts.clear();
            this.frameExecutionContexts.clear();
            this.refMap.clear();
            await sleep(delay);
            continue;
          }
        }
        throw e;
      }
    }

    throw lastError ?? new Error('Stale node retry exhausted');
  }

  /**
   * Find an element using single or multiple selectors
   * Supports ref:, text:, and role: selectors.
   *
   * The candidate array is an ordered preference list — "most-specific/explicit
   * hint first, fallbacks after" — so array position is authoritative. We make a
   * SINGLE ordered pass that tries each candidate in the caller's order and
   * returns the first that resolves to an element:
   *   - a `ref:` entry resolves instantly via its backendNodeId (no polling); a
   *     stale/missing ref falls through to the next candidate.
   *   - a runtime selector (CSS / [attr] / descendant / `text:` / `role:`) is
   *     probed with an INSTANT visibility check here.
   * A `ref:` no longer jumps ahead of a runtime selector that precedes it — the
   * only behavioral change vs. the old ref-first pass. If nothing is present yet,
   * the waiting pass below polls the runtime selectors (in author order) so
   * late-appearing elements still resolve; refs are static (a snapshot's
   * backendNodeIds), so a ref that failed above can never "appear" later and
   * needs no waiting.
   */
  private async findElement(
    selectors: string | string[],
    options: { timeout?: number } = {}
  ): Promise<ElementInfo | null> {
    // Safety net (C1): resolving elements here uses the parent/default session.
    // While a cross-origin iframe (OOPIF) is active, supported in-frame actions
    // route to the child session via findElementInSession and never reach here,
    // so any caller that DOES reach here would silently act on the parent — stop
    // it cold. Belt-and-suspenders behind the per-method guards.
    if (this.currentFrameSession !== null) {
      this.assertOopifUnsupported('This action');
    }

    const { timeout = DEFAULT_TIMEOUT } = options;
    const selectorList = Array.isArray(selectors) ? selectors : [selectors];

    // Clear last matched selector at the start
    this._lastMatchedSelector = undefined;

    // Single ordered pass — honor the caller's candidate order.
    for (const selector of selectorList) {
      if (selector.startsWith('ref:')) {
        const refMatch = await this.resolveRefSelector(selector);
        if (refMatch) {
          this._lastMatchedSelector = selector;
          return refMatch;
        }
        continue; // stale/missing ref → try next candidate
      }

      // Runtime selector: instant visibility check (timeout: 0). If it is not
      // present yet, fall through — the waiting pass below will poll for it.
      const immediate = await waitForAnyElement(this.cdp, [selector], {
        state: 'visible',
        timeout: 0,
        contextId: this.currentFrameContextId ?? undefined,
      });
      if (immediate.success && immediate.selector) {
        const match = await this.resolveRuntimeSelector(immediate.selector, immediate.waitedMs);
        if (match) {
          this._lastMatchedSelector = immediate.selector;
          return match;
        }
      }
    }

    // Stale ref recovery: if all selectors were refs and none worked, try matching by role+name
    if (selectorList.every((s) => s.startsWith('ref:')) && this.lastSnapshot) {
      const oldFingerprints = buildFingerprintMap(this.lastSnapshot.accessibilityTree);
      for (const selector of selectorList) {
        const ref = selector.slice(4);
        const staleFingerprint = oldFingerprints.get(ref);
        if (!staleFingerprint) continue;

        // Take a fresh snapshot and recover only when the semantic match is
        // both strong enough and separated from the next candidate.
        const freshSnapshot = await this.snapshot();
        const currentFingerprints = buildFingerprintMap(freshSnapshot.accessibilityTree);
        const recovery = recoverStaleRef(staleFingerprint, currentFingerprints, 0.75, 0.15);
        const match = recovery
          ? freshSnapshot.interactiveElements.find((element) => element.ref === recovery.ref)
          : undefined;

        if (match && recovery) {
          const newBackendNodeId = this.refMap.get(match.ref);
          if (newBackendNodeId) {
            try {
              await this.ensureRootNode();
              const pushResult = await this.cdp.send<{ nodeIds: number[] }>(
                'DOM.pushNodesByBackendIdsToFrontend',
                { backendNodeIds: [newBackendNodeId] }
              );
              if (pushResult.nodeIds?.[0]) {
                this._lastStaleRecovery = {
                  oldRef: ref,
                  newRef: match.ref,
                  confidence: recovery.confidence,
                  ambiguityMargin: 0.15,
                  oldFingerprint: staleFingerprint,
                  newFingerprint: currentFingerprints.get(match.ref),
                  alternatives: [...currentFingerprints.entries()]
                    .map(([candidateRef, fingerprint]) => ({
                      ref: candidateRef,
                      confidence:
                        Math.round(fingerprintSimilarity(staleFingerprint, fingerprint) * 1000) /
                        1000,
                    }))
                    .sort((a, b) => b.confidence - a.confidence)
                    .slice(0, 5),
                };
                this._lastMatchedSelector = `ref:${match.ref}`;
                return {
                  nodeId: pushResult.nodeIds[0],
                  backendNodeId: newBackendNodeId,
                  selector: `ref:${match.ref}`,
                  waitedMs: 0,
                };
              }
            } catch {}
          }
        }
      }
    }

    // Waiting pass: nothing was present immediately. Poll the runtime selectors
    // (in author order) so late-appearing elements still resolve. refs are
    // static and already failed above, so only runtime selectors remain here.
    const runtimeSelectors = selectorList.filter((s) => !s.startsWith('ref:'));
    if (runtimeSelectors.length === 0) {
      return null; // All were ref selectors and none worked
    }

    const result = await waitForAnyElement(this.cdp, runtimeSelectors, {
      state: 'visible',
      timeout,
      contextId: this.currentFrameContextId ?? undefined,
    });

    if (!result.success || !result.selector) {
      return null;
    }

    const match = await this.resolveRuntimeSelector(result.selector, result.waitedMs);
    if (match) {
      this._lastMatchedSelector = result.selector;
    }
    return match;
  }

  /**
   * Resolve a `ref:eN` selector to a live node via its snapshot backendNodeId.
   * Returns null (so the caller falls through to the next candidate) when the
   * ref is missing from the current map or its backend node is stale.
   */
  private async resolveRefSelector(selector: string): Promise<ElementInfo | null> {
    const ref = selector.slice(4); // Extract "e4" from "ref:e4"
    const backendNodeId = this.refMap.get(ref);
    if (!backendNodeId) {
      return null;
    }

    // Resolve backendNodeId to nodeId by pushing to frontend
    try {
      await this.ensureRootNode();
      const pushResult = await this.cdp.send<{ nodeIds: number[] }>(
        'DOM.pushNodesByBackendIdsToFrontend',
        {
          backendNodeIds: [backendNodeId],
        }
      );

      if (pushResult.nodeIds?.[0]) {
        return {
          nodeId: pushResult.nodeIds[0],
          backendNodeId,
          selector,
          waitedMs: 0,
        };
      }
    } catch {}

    return null;
  }

  /**
   * Resolve a runtime selector (CSS / [attr] / descendant / `text:` / `role:`)
   * that has already been confirmed present, into an {@link ElementInfo}.
   * Tries special-selector lookup, then standard querySelector, then a
   * shadow-piercing deep query. Returns null if the node cannot be materialized.
   */
  private async resolveRuntimeSelector(
    selector: string,
    waitedMs: number
  ): Promise<ElementInfo | null> {
    const specialSelectorMatch = await this.resolveSpecialSelector(selector);
    if (specialSelectorMatch) {
      return {
        ...specialSelectorMatch,
        waitedMs,
      };
    }

    // Get the node using deep query (pierces shadow DOM)
    await this.ensureRootNode();

    // First try standard querySelector (faster for non-shadow DOM)
    const queryResult = await this.cdp.send<{ nodeId: number }>('DOM.querySelector', {
      nodeId: this.rootNodeId!,
      selector,
    });

    if (queryResult.nodeId) {
      // Get backend node ID
      const describeResult = await this.cdp.send<{ node: { backendNodeId: number } }>(
        'DOM.describeNode',
        { nodeId: queryResult.nodeId }
      );

      return {
        nodeId: queryResult.nodeId,
        backendNodeId: describeResult.node.backendNodeId,
        selector,
        waitedMs,
      };
    }

    // Fall back to deep query for shadow DOM elements
    const deepQueryResult = await this.evaluateInFrame<{ result: RemoteObject }>(
      `(() => {
        ${DEEP_QUERY_SCRIPT}
        return deepQuery(${JSON.stringify(selector)});
      })()`,
      { returnByValue: false }
    );

    if (!deepQueryResult.result.objectId) {
      return null;
    }

    // Request the node from the RemoteObject
    const nodeResult = await this.cdp.send<{ nodeId: number }>('DOM.requestNode', {
      objectId: deepQueryResult.result.objectId,
    });

    if (!nodeResult.nodeId) {
      return null;
    }

    // Get backend node ID
    const describeResult = await this.cdp.send<{ node: { backendNodeId: number } }>(
      'DOM.describeNode',
      { nodeId: nodeResult.nodeId }
    );

    return {
      nodeId: nodeResult.nodeId,
      backendNodeId: describeResult.node.backendNodeId,
      selector,
      waitedMs,
    };
  }

  private formatEvaluationError(details: ExceptionDetails): string {
    const description =
      (typeof details.exception?.description === 'string' && details.exception.description) ||
      (typeof details.exception?.value === 'string' && details.exception.value) ||
      details.text ||
      'Uncaught';

    return `Evaluation failed: ${description}`;
  }

  private async resolveSpecialSelector(
    selector: string,
    options: { includeHidden?: boolean } = {}
  ): Promise<ElementInfo | null> {
    const expression = buildSpecialSelectorLookupExpression(selector, options);
    if (!expression) return null;

    const result = await this.evaluateInFrame<{ result: RemoteObject }>(expression, {
      returnByValue: false,
    });

    if (!result.result.objectId) {
      return null;
    }

    const resolved = await this.objectIdToNode(result.result.objectId);
    if (!resolved) {
      return null;
    }

    return {
      nodeId: resolved.nodeId,
      backendNodeId: resolved.backendNodeId,
      selector,
      waitedMs: 0,
    };
  }

  private async readCheckedState(objectId: string): Promise<boolean> {
    const result = await this.cdp.send<{ result: { value: boolean } }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function() { return !!this.checked; }',
      returnByValue: true,
    });
    return result.result.value === true;
  }

  private async readInputType(objectId: string): Promise<string | null> {
    const result = await this.cdp.send<{ result: { value: string | null } }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration:
          'function() { return this instanceof HTMLInputElement ? String(this.type || "").toLowerCase() : null; }',
        returnByValue: true,
      }
    );
    return result.result.value ?? null;
  }

  private async getAssociatedLabelNodeId(objectId: string): Promise<number | null> {
    const result = await this.cdp.send<{ result: RemoteObject }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        if (!(this instanceof HTMLInputElement)) return null;

        if (this.id) {
          var labels = Array.from(document.querySelectorAll('label'));
          for (var i = 0; i < labels.length; i++) {
            if (labels[i].htmlFor === this.id) return labels[i];
          }
        }

        return this.closest('label');
      }`,
      returnByValue: false,
    });

    if (!result.result.objectId) {
      return null;
    }

    return (await this.objectIdToNode(result.result.objectId))?.nodeId ?? null;
  }

  private async objectIdToNode(
    objectId: string
  ): Promise<{ nodeId: number; backendNodeId: number } | null> {
    const describeResult = await this.cdp.send<{
      node: { nodeId: number; backendNodeId: number };
    }>('DOM.describeNode', {
      objectId,
      depth: 0,
    });

    const backendNodeId = describeResult.node.backendNodeId;
    if (!backendNodeId) {
      return null;
    }

    if (describeResult.node.nodeId) {
      return {
        nodeId: describeResult.node.nodeId,
        backendNodeId,
      };
    }

    await this.ensureRootNode();

    const pushResult = await this.cdp.send<{ nodeIds: number[] }>(
      'DOM.pushNodesByBackendIdsToFrontend',
      {
        backendNodeIds: [backendNodeId],
      }
    );

    const nodeId = pushResult.nodeIds?.[0];
    if (!nodeId) {
      return null;
    }

    return { nodeId, backendNodeId };
  }

  private async tryClickAssociatedLabel(
    objectId: string,
    dispatch: ActionDispatch
  ): Promise<boolean> {
    const inputType = await this.readInputType(objectId);
    if (inputType !== 'checkbox' && inputType !== 'radio') {
      return false;
    }

    const labelNodeId = await this.getAssociatedLabelNodeId(objectId);
    if (!labelNodeId) {
      return false;
    }

    try {
      await this.scrollIntoView(labelNodeId);
      await this.clickElement(labelNodeId, dispatch);
      return true;
    } catch (error) {
      if (dispatch.hasPotentiallyDispatched) {
        throw error;
      }
      return false;
    }
  }

  /**
   * Ensure we have a valid root node ID
   */
  private async ensureRootNode(): Promise<void> {
    if (this.rootNodeId) return;

    // OOPIF active: the frame's DOM lives in its own child session and is
    // reached via the dedicated in-session helpers, not this shared rootNodeId.
    // Do NOT re-root through the default session here (that would resolve a
    // null contentDocument and silently drop us out of the frame).
    if (this.currentFrameSession) {
      this.rootNodeId = await this.ensureOopifRootReady(DEFAULT_TIMEOUT);
      return;
    }

    if (this.currentFrame) {
      const mainDocument = await this.cdp.send<{ root: { nodeId: number } }>('DOM.getDocument', {
        depth: 0,
      });
      const iframeNode = await this.cdp.send<{ nodeId: number }>('DOM.querySelector', {
        nodeId: mainDocument.root.nodeId,
        selector: this.currentFrame,
      });

      if (iframeNode.nodeId) {
        const frameResult = await this.cdp.send<{
          node: {
            contentDocument?: { nodeId: number };
            frameId?: string;
          };
        }>('DOM.describeNode', {
          nodeId: iframeNode.nodeId,
          depth: 1,
        });

        if (frameResult.node.contentDocument?.nodeId) {
          this.rootNodeId = frameResult.node.contentDocument.nodeId;
          if (frameResult.node.frameId) {
            // Wait for the execution context via event instead of polling
            let contextId = this.frameExecutionContexts.get(frameResult.node.frameId);
            if (!contextId) {
              contextId = await this.waitForFrameContext(frameResult.node.frameId, 1000);
            }
            this.currentFrameContextId = contextId ?? null;
          }
          return;
        }
      }

      // Frame is no longer available; fall back to the main document.
      this.currentFrame = null;
      this.currentFrameContextId = null;
    }

    const doc = await this.cdp.send<{ root: { nodeId: number } }>('DOM.getDocument', {
      depth: 0,
    });
    this.rootNodeId = doc.root.nodeId;
  }

  /**
   * Execute Runtime.evaluate in the current frame context
   * Automatically injects contextId when in an iframe
   */
  private async evaluateInFrame<T>(
    expression: string,
    options: { returnByValue?: boolean; awaitPromise?: boolean } = {}
  ): Promise<T> {
    // Guard against silent degradation in broken iframe contexts
    if (this.brokenFrame && this.currentFrame) {
      throw new Error(
        `Cannot evaluate JavaScript in frame "${this.brokenFrame}": ` +
          'execution context is unavailable (cross-origin or sandboxed iframe). ' +
          'DOM operations (click, fill, etc.) may still work via CDP.'
      );
    }

    const params: Record<string, unknown> = {
      expression,
      returnByValue: options.returnByValue ?? true,
      awaitPromise: options.awaitPromise ?? false,
    };

    if (this.currentFrameContextId !== null) {
      params['contextId'] = this.currentFrameContextId;
    }

    return this.cdp.send<T>('Runtime.evaluate', params);
  }

  /**
   * Scroll an element into view, with fallback to center-scroll if clipped by fixed headers
   */
  private async scrollIntoView(nodeId: number): Promise<void> {
    await this.cdp.send('DOM.scrollIntoViewIfNeeded', { nodeId });

    // Validate element is actually in viewport; if not, try explicit center scroll
    if (!(await this.isInViewport(nodeId))) {
      const objectId = await this.resolveObjectId(nodeId);
      await this.cdp.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() { this.scrollIntoView({ block: 'center', inline: 'center' }); }`,
      });
    }
  }

  /**
   * Check if element is within the visible viewport
   */
  private async isInViewport(nodeId: number): Promise<boolean> {
    try {
      const objectId = await this.resolveObjectId(nodeId);
      const result = await this.cdp.send<{ result: { value: boolean } }>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
          var rect = this.getBoundingClientRect();
          return (
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= window.innerHeight &&
            rect.right <= window.innerWidth &&
            rect.width > 0 &&
            rect.height > 0
          );
        }`,
        returnByValue: true,
      });
      return result?.result?.value === true;
    } catch {
      return true; // Assume in viewport if check fails
    }
  }

  /**
   * Get element box model (position and dimensions)
   */
  private async getBoxModel(nodeId: number): Promise<BoxModel | null> {
    try {
      const result = await this.cdp.send<{ model: BoxModel }>('DOM.getBoxModel', {
        nodeId,
      });
      return result.model;
    } catch {
      return null;
    }
  }

  /**
   * Click an element by node ID using Playwright's 3-event sequence:
   * mouseMoved → mousePressed → mouseReleased (sequential).
   * Uses DOM.getContentQuads for accurate coordinates (handles CSS transforms).
   * Uses JS this.click() for hidden documents because Chrome acknowledges
   * coordinate input on background targets without delivering DOM mouse/click
   * events. Visible documents use the trusted coordinate sequence. If that
   * sequence fails before an effectful mouse event was accepted, JS fallback is
   * still safe; once mousePressed or mouseReleased may have reached the page,
   * the error is surfaced as uncertain.
   */
  private async clickElement(nodeId: number, dispatch: ActionDispatch): Promise<void> {
    // Get objectId for getContentQuads
    const { object } = await this.cdp.send<{ object: { objectId: string } }>('DOM.resolveNode', {
      nodeId,
    });

    // Try getContentQuads first (more accurate for CSS-transformed elements)
    let x: number;
    let y: number;
    try {
      const { quads } = await this.cdp.send<{ quads: number[][] }>('DOM.getContentQuads', {
        objectId: object.objectId,
      });
      if (quads && quads.length > 0) {
        const quad = quads[0]!;
        // Quad is [x1,y1,x2,y2,x3,y3,x4,y4] — center = average of 4 corners
        x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
        y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
      } else {
        throw new Error('No quads');
      }
    } catch {
      // Fallback to getBoxModel
      const box = await this.getBoxModel(nodeId);
      if (!box) throw new Error('Could not get element position for click');
      x = box.content[0]! + box.width / 2;
      y = box.content[1]! + box.height / 2;
    }

    // Chrome accepts Input.dispatchMouseEvent for a background target but
    // suppresses the renderer's pointer/mouse/click dispatch. Use the DOM
    // activation path before sending any effectful input event so the click
    // still mutates page state without foregrounding the tab. This remains
    // synthetic (untrusted), matching the existing OOPIF click path.
    const visibility = await this.cdp.send<{
      result: { value?: string };
    }>('Runtime.evaluate', {
      expression: 'document.visibilityState',
      returnByValue: true,
    });
    if (visibility.result.value === 'hidden') {
      await dispatch.send(
        () =>
          this.cdp.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: 'function() { this.click(); }',
          }),
        'javascriptClick'
      );
      return;
    }

    // Sequential mouse events (Playwright pattern). mouseMoved is preparatory;
    // mousePressed and mouseReleased cross the side-effect boundary.
    try {
      await dispatch.send(
        () =>
          this.cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x,
            y,
            button: 'none',
            buttons: 0,
            modifiers: 0,
          }),
        'mouseMoved',
        { effectful: false }
      );
      await dispatch.send(
        () =>
          this.cdp.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x,
            y,
            button: 'left',
            buttons: 1,
            clickCount: 1,
            modifiers: 0,
          }),
        'mousePressed'
      );
      await dispatch.send(
        () =>
          this.cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x,
            y,
            button: 'left',
            buttons: 0,
            clickCount: 1,
            modifiers: 0,
          }),
        'mouseReleased'
      );
    } catch (error) {
      // JS fallback is valid only before an effectful mouse event. In
      // particular, never turn a failed mousePressed/mouseReleased into a
      // second click.
      if (!dispatch.canRetryAction) throw error;
      await dispatch.send(
        () =>
          this.cdp.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: 'function() { this.click(); }',
          }),
        'javascriptClick'
      );
    }
  }

  /**
   * Resolve a nodeId to a Remote Object ID for use with Runtime.callFunctionOn
   */
  private async resolveObjectId(nodeId: number): Promise<string> {
    const { object } = await this.cdp.send<{ object: { objectId: string } }>('DOM.resolveNode', {
      nodeId,
    });
    return object.objectId;
  }

  private async dispatchKeyDefinition(
    def: KeyDefinition,
    modifierBitmask = 0,
    sessionId?: string,
    dispatch?: ActionDispatch,
    suppressText = false
  ): Promise<void> {
    const hasText = def.text !== undefined && !suppressText;
    const downParams: Record<string, unknown> = {
      type: hasText ? 'keyDown' : 'rawKeyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      modifiers: modifierBitmask,
      autoRepeat: false,
      location: def.location ?? 0,
      isKeypad: false,
    };

    if (hasText) {
      downParams['text'] = def.text;
      downParams['unmodifiedText'] = def.text;
    }

    const send = dispatch
      ? <T>(operation: () => Promise<T>, eventName: string) => dispatch.send(operation, eventName)
      : <T>(operation: () => Promise<T>) => operation();

    await send(() => this.cdp.send('Input.dispatchKeyEvent', downParams, sessionId), 'keyDown');
    await send(
      () =>
        this.cdp.send(
          'Input.dispatchKeyEvent',
          {
            type: 'keyUp',
            key: def.key,
            code: def.code,
            windowsVirtualKeyCode: def.keyCode,
            modifiers: modifierBitmask,
            location: def.location ?? 0,
          },
          sessionId
        ),
      'keyUp'
    );
  }

  private async dispatchKey(
    key: string,
    sessionId?: string,
    dispatch?: ActionDispatch
  ): Promise<void> {
    const def = US_KEYBOARD[key];
    if (def) {
      await this.dispatchKeyDefinition(def, 0, sessionId, dispatch);
      return;
    }

    if (key.length === 1) {
      if (dispatch) {
        await dispatch.send(
          () => this.cdp.send('Input.insertText', { text: key }, sessionId),
          'insertText'
        );
      } else {
        await this.cdp.send('Input.insertText', { text: key }, sessionId);
      }
      return;
    }

    await this.dispatchKeyDefinition({ key, code: key, keyCode: 0 }, 0, sessionId, dispatch);
  }

  private async dispatchKeyWithModifiers(
    key: string,
    modifiers: ModifierKey[],
    sessionId?: string,
    dispatch?: ActionDispatch
  ): Promise<void> {
    const mask = computeModifierBitmask(modifiers);

    // Press modifier keys down
    for (const mod of modifiers) {
      const params = {
        type: 'rawKeyDown',
        key: mod,
        code: MODIFIER_CODES[mod],
        windowsVirtualKeyCode: MODIFIER_KEY_CODES[mod],
        modifiers: mask,
        location: 1,
      };
      if (dispatch) {
        await dispatch.send(
          () => this.cdp.send('Input.dispatchKeyEvent', params, sessionId),
          'modifierKeyDown',
          { effectful: false }
        );
      } else {
        await this.cdp.send('Input.dispatchKeyEvent', params, sessionId);
      }
    }

    // Dispatch the main key with modifiers held. A printable `text` payload
    // can turn a modified key into an insertion on some Chrome versions
    // (for example, Meta+a inserts `a` before the select-all fallback runs).
    // Control/Meta/Alt combinations are commands, so omit printable text.
    const suppressText = modifiers.some((mod) => mod !== 'Shift');
    const def = US_KEYBOARD[key];
    if (def) {
      await this.dispatchKeyDefinition(def, mask, sessionId, dispatch, suppressText);
    } else if (key.length === 1) {
      // For single characters with modifiers, use dispatchKeyEvent instead of insertText
      // so the modifiers are included in the event
      await this.dispatchKeyDefinition(
        { key, code: key, keyCode: 0, text: key },
        mask,
        sessionId,
        dispatch,
        suppressText
      );
    } else {
      await this.dispatchKeyDefinition({ key, code: key, keyCode: 0 }, mask, sessionId, dispatch);
    }

    // Release modifier keys (reverse order)
    for (let i = modifiers.length - 1; i >= 0; i--) {
      const mod = modifiers[i]!;
      const params = {
        type: 'keyUp',
        key: mod,
        code: MODIFIER_CODES[mod],
        windowsVirtualKeyCode: MODIFIER_KEY_CODES[mod],
        modifiers: 0,
        location: 1,
      };
      if (dispatch) {
        await dispatch.send(
          () => this.cdp.send('Input.dispatchKeyEvent', params, sessionId),
          'modifierKeyUp',
          { effectful: false }
        );
      } else {
        await this.cdp.send('Input.dispatchKeyEvent', params, sessionId);
      }
    }
  }

  // ============ Audio I/O ============

  /**
   * Audio input controller (fake microphone).
   * Lazy-initialized on first access.
   */
  get audioInput(): AudioInput {
    if (!this._audioInput) {
      this._audioInput = new AudioInput(this.cdp);
    }
    return this._audioInput;
  }

  /**
   * Audio output capture controller.
   * Lazy-initialized on first access.
   */
  get audioOutput(): AudioOutput {
    if (!this._audioOutput) {
      this._audioOutput = new AudioOutput(this.cdp);
    }
    return this._audioOutput;
  }

  /**
   * Set up both audio input (fake microphone) and output (capture).
   * Must be called before navigating to the page that will use audio.
   */
  async setupAudio(): Promise<void> {
    // Dispatch a synthetic click to establish a user gesture context.
    // Chrome suspends AudioContexts created without a user gesture;
    // this click makes subsequent AudioContext.resume() calls succeed.
    try {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: 0,
        y: 0,
        button: 'left',
        clickCount: 1,
      });
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: 0,
        y: 0,
        button: 'left',
        clickCount: 1,
      });
    } catch {
      // Non-fatal — some targets don't support Input domain
    }

    await this.audioInput.setup();
    await this.audioOutput.setup();
  }

  /**
   * Full audio round-trip: feed input audio, capture the response.
   *
   * 1. Starts capturing output
   * 2. Feeds input audio as microphone data
   * 3. Waits for the page to respond and then go silent
   * 4. Returns the captured response audio with latency metrics
   *
   * @example
   * ```typescript
   * await page.setupAudio();
   * await page.goto('https://voice-agent.example.com');
   * const result = await page.audioRoundTrip({
   *   input: wavFileBytes,
   *   silenceTimeout: 3000,
   * });
   * console.log(`Response: ${result.audio.durationMs}ms, latency: ${result.latencyMs}ms`);
   * ```
   */
  async audioRoundTrip(options: RoundTripOptions): Promise<RoundTripResult> {
    // Ensure audio is set up
    if (!this.audioInput.isSetup || !this.audioOutput.isSetup) {
      await this.setupAudio();
    }

    const start = Date.now();

    // Start capture once — captureUntilSilence will skip its internal start()
    // since we're already capturing
    await this.audioOutput.start();

    if (options.preDelay && options.preDelay > 0) {
      await sleep(options.preDelay);
    }

    // Don't await — agent may start responding before input finishes
    const inputDone = this.audioInput.play(options.input, {
      waitForEnd: !!options.sendSelector,
    });

    // For push-to-talk: wait for input to finish, then click send
    if (options.sendSelector) {
      await inputDone.catch(() => {});
      await this.click(options.sendSelector);
    }

    // captureUntilSilence uses two-phase detection:
    // Phase 1: Wait for first non-silent audio (no timeout countdown)
    // Phase 2: Once audio detected, stop after silenceTimeout ms of silence
    const audio: CaptureResult = await this.audioOutput.captureUntilSilence({
      silenceTimeout: options.silenceTimeout ?? 1500,
      silenceThreshold: options.silenceThreshold ?? 0.01,
      maxDuration: options.timeout ?? 120000,
    });

    await this.audioInput.stop();
    if (!options.sendSelector) {
      await inputDone.catch(() => {});
    }

    const firstChunkTime = this.audioOutput.firstChunkTime;

    return {
      audio,
      latencyMs: firstChunkTime !== null ? firstChunkTime - start : -1,
      totalMs: Date.now() - start,
    };
  }

  /**
   * Wait for a DOM mutation in the current frame (used for detecting client-side form handling)
   */
  private async waitForDOMMutation(options: { timeout: number }): Promise<void> {
    await this.evaluateInFrame(
      `new Promise((resolve) => {
        var observer = new MutationObserver(function() {
          observer.disconnect();
          resolve();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(function() { observer.disconnect(); resolve(); }, ${options.timeout});
      })`
    );
  }

  /**
   * Wait for a frame execution context via Runtime.executionContextCreated event
   */
  private async waitForFrameContext(frameId: string, timeout: number): Promise<number | undefined> {
    // Check if it appeared while we were setting up
    const existing = this.frameExecutionContexts.get(frameId);
    if (existing) return existing;

    return new Promise<number | undefined>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(undefined);
      }, timeout);

      const handler = (params: Record<string, unknown>) => {
        const context = params['context'] as {
          id: number;
          auxData?: { frameId?: string; isDefault?: boolean };
        };
        if (context.auxData?.frameId === frameId && context.auxData?.isDefault !== false) {
          cleanup();
          resolve(context.id);
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.cdp.off('Runtime.executionContextCreated', handler);
      };

      this.cdp.on('Runtime.executionContextCreated', handler);
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
