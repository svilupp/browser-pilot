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
import type {
  ClearCookiesOptions,
  Cookie,
  DeleteCookieOptions,
  SetCookieOptions,
} from '../storage/types.ts';
import {
  DEEP_QUERY_SCRIPT,
  waitForAnyElement,
  waitForNetworkIdle as waitForIdle,
  waitForNavigation as waitForNav,
} from '../wait/index.ts';
import { ActionabilityError, ensureActionable } from './actionability.ts';
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
import { buildSpecialSelectorLookupExpression } from './special-selectors.ts';
import {
  type ActionOptions,
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
  type EmulationState,
  type ErrorHandler,
  type FileInput,
  type FillOptions,
  type FormField,
  type GeolocationOptions,
  type InteractiveElement,
  type NetworkIdleOptions,
  type PageError,
  type PageSnapshot,
  type SnapshotNode,
  type SnapshotOptions,
  type SubmitOptions,
  TimeoutError,
  type TypeOptions,
  type UserAgentOptions,
  type ViewportOptions,
  type WaitForOptions,
} from './types.ts';

const DEFAULT_TIMEOUT = 30000;
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
  /** Last matched selector from findElement (for selectorUsed tracking) */
  private _lastMatchedSelector: string | undefined;
  /** Last snapshot for stale ref recovery */
  private lastSnapshot?: PageSnapshot;
  /** Audio input controller (lazy-initialized) */
  private _audioInput?: AudioInput;
  /** Audio output controller (lazy-initialized) */
  private _audioOutput?: AudioOutput;

  constructor(cdp: CDPClient, targetId: string) {
    this.cdp = cdp;
    this._targetId = targetId;
    this.batchExecutor = new BatchExecutor(this);
  }

  /**
   * Get the CDP target ID for this page
   */
  get targetId(): string {
    return this._targetId;
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
    ]);

    await this.installEventListenerTracker();
  }

  private async installEventListenerTracker(): Promise<void> {
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

  // ============ Navigation ============

  /**
   * Navigate to a URL
   */
  async goto(url: string, options: ActionOptions = {}): Promise<void> {
    const { timeout = DEFAULT_TIMEOUT } = options;

    // Start navigation
    const navPromise = this.waitForNavigation({ timeout });

    await this.cdp.send('Page.navigate', { url });

    const result = await navPromise;
    if (!result) {
      throw new TimeoutError(`Navigation to ${url} timed out after ${timeout}ms`);
    }

    // Refresh root node, clear ref map, and reset frame state after navigation
    this.rootNodeId = null;
    this.refMap.clear();
    this.currentFrame = null;
    this.currentFrameContextId = null;
    this.frameContexts.clear();
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

    const navPromise = this.waitForNavigation({ timeout });
    await this.cdp.send('Page.reload');
    await navPromise;

    this.rootNodeId = null;
    this.refMap.clear();
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

    const navPromise = this.waitForNavigation({ timeout });

    // Use CDP navigation instead of history.back() - fires proper events
    await this.cdp.send('Page.navigateToHistoryEntry', {
      entryId: history.entries[history.currentIndex - 1]!.id,
    });

    await navPromise;
    this.rootNodeId = null;
    this.refMap.clear();
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

    const navPromise = this.waitForNavigation({ timeout });

    // Use CDP navigation instead of history.forward() - fires proper events
    await this.cdp.send('Page.navigateToHistoryEntry', {
      entryId: history.entries[history.currentIndex + 1]!.id,
    });

    await navPromise;
    this.rootNodeId = null;
    this.refMap.clear();
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
    return this.withStaleNodeRetry(async () => {
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
          (await this.tryClickAssociatedLabel(objectId))
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
        } else {
          throw new Error('No quads');
        }
      } catch {
        const box = await this.getBoxModel(element.nodeId);
        if (!box) throw new Error('Could not get element position');
        clickX = box.content[0]! + box.width / 2;
        clickY = box.content[1]! + box.height / 2;
      }

      // Hit target checks inside iframes need frame-local coordinates, while
      // Input.dispatchMouseEvent still needs the page-level coordinates above.
      const hitTargetCoordinates = this.currentFrame ? undefined : { x: clickX, y: clickY };

      // Hit target check with bounded retry for transient overlays
      const HIT_TARGET_RETRIES = 3;
      const HIT_TARGET_DELAY = 100;

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

      await this.clickElement(element.nodeId);
      return true;
    });
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

    return this.withStaleNodeRetry(async () => {
      const element = await this.findElement(selector, options);

      if (!element) {
        if (options.optional) return false;
        const selectorList = Array.isArray(selector) ? selector : [selector];
        const hints = await generateHints(this, selectorList, 'fill');
        throw new ElementNotFoundError(selector, hints);
      }

      // Resolve nodeId to objectId for Runtime.callFunctionOn
      const { object } = await this.cdp.send<{ object: { objectId: string } }>('DOM.resolveNode', {
        nodeId: element.nodeId,
      });
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

      // Check if this is a special input type that can't use Input.insertText
      const tagInfo = await this.cdp.send<{
        result: { value: { tagName: string; inputType: string } };
      }>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
            return { tagName: this.tagName?.toLowerCase() || '', inputType: (this.type || '').toLowerCase() };
          }`,
        returnByValue: true,
      });
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
        await this.cdp.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function(val) {
            this.value = val;
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
          }`,
          arguments: [{ value }],
          returnByValue: true,
        });
      } else {
        // Playwright pattern: focus + select all, then insertText/Delete.
        await this.selectEditableContent(objectId);

        if (value === '') {
          // Empty value: send Delete key to clear selected text (Playwright pattern)
          await this.dispatchKey('Delete');
        } else {
          // Non-empty: Input.insertText fires real isTrusted:true events
          await this.cdp.send('Input.insertText', { text: value });
        }
      }

      if (options.verify !== false) {
        let actualValue = await this.readEditableValue(objectId);

        if (actualValue !== value && !isSpecialInput) {
          if (value === '') {
            await this.clearEditableSelection(objectId, 'Backspace');
          } else {
            await this.typeEditableFallback(element.nodeId, objectId, value);
          }
          actualValue = await this.readEditableValue(objectId);
        }

        if (actualValue !== value) {
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
    });
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
    return this.withStaleNodeRetry(async () => {
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

      await this.cdp.send('DOM.focus', { nodeId: element.nodeId });

      for (const char of text) {
        const def = US_KEYBOARD[char];

        if (def) {
          if (def.text !== undefined) {
            // Printable character: 'keyDown' with text fields
            await this.cdp.send('Input.dispatchKeyEvent', {
              type: 'keyDown',
              key: def.key,
              code: def.code,
              text: def.text,
              unmodifiedText: def.text,
              windowsVirtualKeyCode: def.keyCode,
              modifiers: 0,
              autoRepeat: false,
              location: def.location ?? 0,
              isKeypad: false,
            });
          } else {
            // Non-text key (Enter, Tab, etc.): 'rawKeyDown', no text
            await this.cdp.send('Input.dispatchKeyEvent', {
              type: 'rawKeyDown',
              key: def.key,
              code: def.code,
              windowsVirtualKeyCode: def.keyCode,
              modifiers: 0,
              autoRepeat: false,
              location: def.location ?? 0,
              isKeypad: false,
            });
          }

          await this.cdp.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: def.key,
            code: def.code,
            windowsVirtualKeyCode: def.keyCode,
            modifiers: 0,
            location: def.location ?? 0,
          });
        } else {
          // Non-layout character (emoji, CJK): use insertText
          await this.cdp.send('Input.insertText', { text: char });
        }

        if (delay > 0) {
          await sleep(delay);
        }
      }

      // Optionally trigger blur
      if (options.blur) {
        await this.cdp.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function() { this.blur(); }',
        });
      }

      return true;
    });
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

    return this.withStaleNodeRetry(async () => {
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
          metadata.targetIndexes[0]!
        );
      }

      let selectedValues = await this.readNativeSelectValues(objectId);
      if (!this.selectValuesMatch(selectedValues, expectedValues, metadata.multiple)) {
        await this.applyNativeSelectFallback(objectId, metadata.targetIndexes);
        selectedValues = await this.readNativeSelectValues(objectId);
      }

      if (!this.selectValuesMatch(selectedValues, expectedValues, metadata.multiple)) {
        await this.applyRecordedSelectFallback(objectId, metadata.targetIndexes);
        selectedValues = await this.readNativeSelectValues(objectId);
      }

      if (!this.selectValuesMatch(selectedValues, expectedValues, metadata.multiple)) {
        if (options.optional) return false;
        throw new Error(
          `Select value did not stick. Expected ${expectedValues.join(', ') || '(empty)'} but got ${selectedValues.join(', ') || '(empty)'}.`
        );
      }

      return true;
    });
  }

  /**
   * Handle custom (non-native) select/dropdown components
   */
  private async selectCustom(
    config: CustomSelectConfig,
    options: ActionOptions = {}
  ): Promise<boolean> {
    const { trigger, option, value, match = 'text' } = config;

    return this.withStaleNodeRetry(async () => {
      // Click the trigger to open dropdown
      await this.click(trigger, options);

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
      await this.clickElement(nodeResult.nodeId);
      return true;
    });
  }

  /**
   * Check a checkbox or radio button using real mouse click.
   * No-op if already checked. Verifies state changed after click.
   */
  async check(selector: string | string[], options: ActionOptions = {}): Promise<boolean> {
    return this.withStaleNodeRetry(async () => {
      const element = await this.findElement(selector, options);
      if (!element) {
        if (options.optional) return false;
        const selectorList = Array.isArray(selector) ? selector : [selector];
        const hints = await generateHints(this, selectorList, 'check');
        throw new ElementNotFoundError(selector, hints);
      }

      const { object } = await this.cdp.send<{ object: { objectId: string } }>('DOM.resolveNode', {
        nodeId: element.nodeId,
      });

      // Actionability checks
      try {
        await ensureActionable(this.cdp, object.objectId, ['visible', 'enabled'], {
          timeout: options.timeout ?? DEFAULT_TIMEOUT,
        });
      } catch (e) {
        if (options.optional) return false;
        throw e;
      }

      // Read current checked state
      const before = await this.cdp.send<{ result: { value: boolean } }>('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function() { return !!this.checked; }',
        returnByValue: true,
      });

      if (before.result.value) return true; // Already checked

      // Real mouse click
      await this.scrollIntoView(element.nodeId);
      await this.clickElement(element.nodeId);

      // Verify state changed
      const after = await this.cdp.send<{ result: { value: boolean } }>('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function() { return !!this.checked; }',
        returnByValue: true,
      });

      if (!after.result.value) {
        if (await this.tryToggleViaLabel(object.objectId, true)) {
          return true;
        }
        throw new Error(
          'Clicking the checkbox did not change its state. Tried the associated label too.'
        );
      }

      return true;
    });
  }

  /**
   * Uncheck a checkbox using real mouse click.
   * No-op if already unchecked. Radio buttons can't be unchecked (returns true).
   */
  async uncheck(selector: string | string[], options: ActionOptions = {}): Promise<boolean> {
    return this.withStaleNodeRetry(async () => {
      const element = await this.findElement(selector, options);
      if (!element) {
        if (options.optional) return false;
        const selectorList = Array.isArray(selector) ? selector : [selector];
        const hints = await generateHints(this, selectorList, 'uncheck');
        throw new ElementNotFoundError(selector, hints);
      }

      const { object } = await this.cdp.send<{ object: { objectId: string } }>('DOM.resolveNode', {
        nodeId: element.nodeId,
      });

      // Actionability checks
      try {
        await ensureActionable(this.cdp, object.objectId, ['visible', 'enabled'], {
          timeout: options.timeout ?? DEFAULT_TIMEOUT,
        });
      } catch (e) {
        if (options.optional) return false;
        throw e;
      }

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
      const before = await this.cdp.send<{ result: { value: boolean } }>('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function() { return !!this.checked; }',
        returnByValue: true,
      });

      if (!before.result.value) return true; // Already unchecked

      // Real mouse click
      await this.scrollIntoView(element.nodeId);
      await this.clickElement(element.nodeId);

      // Verify state changed
      const after = await this.cdp.send<{ result: { value: boolean } }>('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function() { return !!this.checked; }',
        returnByValue: true,
      });

      if (after.result.value) {
        if (await this.tryToggleViaLabel(object.objectId, false)) {
          return true;
        }
        throw new Error(
          'Clicking the checkbox did not change its state. Tried the associated label too.'
        );
      }

      return true;
    });
  }

  /**
   * Submit a form (tries Enter key first, then click)
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
    return this.withStaleNodeRetry(async () => {
      const { method = 'enter+click', waitForNavigation: shouldWait = 'auto' } = options;
      const element = await this.findElement(selector, options);

      if (!element) {
        if (options.optional) return false;
        const selectorList = Array.isArray(selector) ? selector : [selector];
        const hints = await generateHints(this, selectorList, 'submit');
        throw new ElementNotFoundError(selector, hints);
      }

      const objectId = await this.resolveObjectId(element.nodeId);
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
        await this.cdp.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function() {
            if (typeof this.requestSubmit === 'function') {
              this.requestSubmit();
            } else {
              this.submit();
            }
          }`,
        });

        // Handle navigation waiting
        if (shouldWait === true) {
          await this.waitForNavigation({ timeout: options.timeout ?? DEFAULT_TIMEOUT });
        } else if (shouldWait === 'auto') {
          await Promise.race([
            this.waitForNavigation({ timeout: 2000, optional: true }).then(
              () => 'navigation' as const
            ),
            this.waitForDOMMutation({ timeout: 1000 }).then(() => 'mutation' as const),
            sleep(1500).then(() => 'timeout' as const),
          ]);
        }
        return true;
      }

      // For non-form elements, continue with existing focus+enter/click logic
      await this.cdp.send('DOM.focus', { nodeId: element.nodeId });

      // Try Enter first if method includes it
      if (method.includes('enter')) {
        await this.press('Enter');

        if (shouldWait === true) {
          try {
            await this.waitForNavigation({ timeout: options.timeout ?? DEFAULT_TIMEOUT });
            return true;
          } catch {
            // No navigation, try click if method includes it
          }
        } else if (shouldWait === 'auto') {
          // Race: real navigation vs DOM mutation (client-side form) vs timeout
          const navigationDetected = await Promise.race([
            this.waitForNavigation({ timeout: 2000, optional: true }).then((success) =>
              success ? 'nav' : null
            ),
            this.waitForDOMMutation({ timeout: 1000 }).then(() => 'mutation'),
            sleep(1500).then(() => 'timeout'),
          ]);

          if (navigationDetected === 'nav') {
            return true; // Navigation happened, we're done
          }
          // DOM mutation or timeout — assume client-side handling, try click if available
        } else if (method === 'enter') {
          // waitForNavigation: false - don't wait
          return true;
        }
      }

      // Try click if method includes it
      if (method.includes('click')) {
        await this.click(element.selector, { ...options, optional: false });

        if (shouldWait === true) {
          await this.waitForNavigation({ timeout: options.timeout ?? DEFAULT_TIMEOUT });
        } else if (shouldWait === 'auto') {
          // Short wait to allow client-side handlers to run
          await sleep(100);
        }
        // waitForNavigation: false - return immediately
      }

      return true;
    });
  }

  /**
   * Press a key, optionally with modifier keys held down
   */
  async press(
    key: string,
    options?: { modifiers?: Array<'Control' | 'Shift' | 'Alt' | 'Meta'> }
  ): Promise<void> {
    const modifiers = options?.modifiers;
    if (modifiers && modifiers.length > 0) {
      await this.dispatchKeyWithModifiers(key, modifiers);
    } else {
      await this.dispatchKey(key);
    }
  }

  /**
   * Execute a keyboard shortcut (e.g. "Control+a", "Meta+Shift+z")
   */
  async shortcut(combo: string): Promise<void> {
    const { modifiers, key } = parseShortcut(combo);
    await this.dispatchKeyWithModifiers(key, modifiers);
  }

  /**
   * Focus an element
   */
  async focus(selector: string | string[], options: ActionOptions = {}): Promise<boolean> {
    const element = await this.findElement(selector, options);
    if (!element) {
      if (options.optional) return false;
      const selectorList = Array.isArray(selector) ? selector : [selector];
      const hints = await generateHints(this, selectorList, 'focus');
      throw new ElementNotFoundError(selector, hints);
    }

    await this.cdp.send('DOM.focus', { nodeId: element.nodeId });
    return true;
  }

  /**
   * Hover over an element
   */
  async hover(selector: string | string[], options: ActionOptions = {}): Promise<boolean> {
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
    const element = await this.findElement(selector, options);
    if (!element) {
      if (options.optional) return false;
      throw new ElementNotFoundError(selector);
    }

    // Get the iframe's content document and frameId
    const descResult = await this.cdp.send<{
      node: {
        contentDocument?: { nodeId: number; backendNodeId: number };
        frameId?: string;
      };
    }>('DOM.describeNode', {
      nodeId: element.nodeId,
      depth: 1,
    });

    if (!descResult.node.contentDocument) {
      if (options.optional) return false;
      throw new Error(
        'Cannot access iframe content. This may be a cross-origin iframe which requires different handling.'
      );
    }

    // Store the frame context
    const frameKey = Array.isArray(selector) ? selector[0]! : selector;
    this.frameContexts.set(frameKey, descResult.node.contentDocument.nodeId);
    this.currentFrame = frameKey;

    // Update root node to the iframe's document
    this.rootNodeId = descResult.node.contentDocument.nodeId;

    // Get the execution context for this frame
    // The frameId from DOM.describeNode points to the iframe's content frame
    if (descResult.node.frameId) {
      const frameId = descResult.node.frameId;
      const { timeout = DEFAULT_TIMEOUT } = options;

      // Wait for execution context via event instead of polling
      let contextId = this.frameExecutionContexts.get(frameId);
      if (!contextId) {
        contextId = await this.waitForFrameContext(frameId, Math.min(timeout, 2000));
      }

      if (contextId) {
        this.currentFrameContextId = contextId;
        this.brokenFrame = null;
      } else {
        // Context unavailable — mark as broken so evaluate() throws explicitly
        const frameKey = Array.isArray(selector) ? selector[0]! : selector;
        this.brokenFrame = frameKey;
        console.warn(
          `[browser-pilot] Frame "${frameKey}" execution context unavailable. ` +
            'JS evaluation will fail in this frame. DOM operations may still work.'
        );
      }
    }

    // Clear ref map since we're in a new context
    this.refMap.clear();

    return true;
  }

  /**
   * Switch back to the main document from an iframe
   */
  async switchToMain(): Promise<void> {
    this.currentFrame = null;
    this.rootNodeId = null; // Will be re-fetched on next query
    this.currentFrameContextId = null;
    this.brokenFrame = null;
    this.refMap.clear();
  }

  /**
   * Get the current frame context (null = main frame)
   */
  getCurrentFrame(): string | null {
    return this.currentFrame;
  }

  // ============ Waiting ============

  /**
   * Wait for an element to reach a state
   */
  async waitFor(selector: string | string[], options: WaitForOptions = {}): Promise<boolean> {
    const { timeout = DEFAULT_TIMEOUT, state = 'visible' } = options;
    const selectors = Array.isArray(selector) ? selector : [selector];

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
   * Wait for navigation to complete
   */
  async waitForNavigation(options: ActionOptions = {}): Promise<boolean> {
    const { timeout = DEFAULT_TIMEOUT } = options;
    const result = await waitForNav(this.cdp, { timeout });

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

    // Use iframe execution context if we're in a frame
    if (this.currentFrameContextId !== null) {
      params['contextId'] = this.currentFrameContextId;
    }

    const result = await this.cdp.send<{
      result: RemoteObject;
      exceptionDetails?: ExceptionDetails;
    }>('Runtime.evaluate', params);

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
   * Enumerate form controls on the page with labels and current state.
   */
  async forms(): Promise<FormField[]> {
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
    targetIndex: number
  ): Promise<boolean> {
    await this.cdp.send('DOM.focus', { nodeId });

    if (targetIndex !== currentIndex) {
      let effectiveIndex = currentIndex;

      if (effectiveIndex < 0 || targetIndex < effectiveIndex) {
        await this.dispatchKey('Home');
        effectiveIndex = 0;
      }
      const steps = targetIndex - effectiveIndex;
      const direction = steps >= 0 ? 'ArrowDown' : 'ArrowUp';

      for (let i = 0; i < Math.abs(steps); i++) {
        await this.dispatchKey(direction);
      }
    }

    const selectedValues = await this.readNativeSelectValues(objectId);
    return selectedValues[0] !== undefined;
  }

  private async applyNativeSelectFallback(
    objectId: string,
    targetIndexes: number[]
  ): Promise<void> {
    await this.cdp.send('Runtime.callFunctionOn', {
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
    });
  }

  private async selectEditableContent(objectId: string): Promise<void> {
    await this.cdp.send('Runtime.callFunctionOn', {
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
    });
  }

  private async clearEditableSelection(
    objectId: string,
    key: 'Backspace' | 'Delete'
  ): Promise<void> {
    await this.selectEditableContent(objectId);
    await this.dispatchKey(key);
  }

  private async readEditableValue(objectId: string): Promise<string> {
    const result = await this.cdp.send<{ result: { value: string } }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        if (this.isContentEditable) {
          return this.textContent || '';
        }
        return this.value || '';
      }`,
      returnByValue: true,
    });
    return result.result.value ?? '';
  }

  private async typeEditableFallback(
    nodeId: number,
    objectId: string,
    value: string
  ): Promise<void> {
    await this.selectEditableContent(objectId);
    await this.cdp.send('DOM.focus', { nodeId });
    for (const char of value) {
      await this.dispatchKey(char);
    }
  }

  private async applyRecordedSelectFallback(
    objectId: string,
    targetIndexes: number[]
  ): Promise<boolean> {
    await this.cdp.send('Runtime.callFunctionOn', {
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
    });

    return this.invokeRecordedEventListeners(objectId, ['input', 'change']);
  }

  private async invokeRecordedEventListeners(
    objectId: string,
    eventTypes: string[]
  ): Promise<boolean> {
    const result = await this.cdp.send<{ result: { value: boolean } }>('Runtime.callFunctionOn', {
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
    const roleFilter = new Set((options.roles ?? []).map((role) => role.trim().toLowerCase()));
    const [url, title, axTree] = await Promise.all([
      this.url(),
      this.title(),
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
      const checked = node.properties?.find((p) => p.name === 'checked')?.value.value as
        | boolean
        | undefined;

      return {
        role,
        name,
        value: value !== undefined ? String(value) : undefined,
        ref,
        children: children.length > 0 ? children : undefined,
        disabled,
        checked,
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
        const checked = node.properties?.find((p) => p.name === 'checked')?.value.value as
          | boolean
          | undefined;
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
          value: value !== undefined ? String(value) : undefined,
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

    const text =
      roleFilter.size > 0
        ? accessibilityTree.map((node) => formatNode(node)).join('\n')
        : formatTree(accessibilityTree);

    const result: PageSnapshot = {
      url,
      title,
      timestamp: new Date().toISOString(),
      accessibilityTree,
      interactiveElements,
      text,
    };
    if (roleFilter.size === 0) {
      this.lastSnapshot = result; // Store for stale ref recovery
    }
    return result;
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
        if (arg.value !== undefined) return String(arg.value);
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
   * Close this page (no-op for now, managed by Browser)
   * This is a placeholder for API compatibility
   */
  async close(): Promise<void> {
    // Page closing is managed by Browser.closePage()
    // This method exists for API convenience in tests
  }

  // ============ Private Helpers ============

  /**
   * Retry wrapper for operations that may encounter stale nodes
   * Catches "Could not find node with given id" errors and retries
   */
  private async withStaleNodeRetry<T>(
    fn: () => Promise<T>,
    options: { retries?: number; delay?: number } = {}
  ): Promise<T> {
    const { retries = 2, delay = 50 } = options;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const message = e instanceof Error ? e.message : '';
        if (
          e instanceof Error &&
          (message.includes('Could not find node with given id') ||
            message.includes('Node with given id does not belong to the document') ||
            message.includes('No node with given id found') ||
            message.includes('Could not find object with given id') ||
            message.includes('Cannot find context with specified id') ||
            message.includes('Cannot find context with given id') ||
            message.includes('Execution context was destroyed') ||
            message.includes('No execution context with given id') ||
            message.includes('Argument should belong to the same JavaScript world'))
        ) {
          lastError = e;
          if (attempt < retries) {
            // Reset cached DOM/context state so the next attempt re-resolves fresh handles.
            this.rootNodeId = null;
            this.currentFrameContextId = null;
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
   */
  private async findElement(
    selectors: string | string[],
    options: { timeout?: number } = {}
  ): Promise<ElementInfo | null> {
    const { timeout = DEFAULT_TIMEOUT } = options;
    const selectorList = Array.isArray(selectors) ? selectors : [selectors];

    // Clear last matched selector at the start
    this._lastMatchedSelector = undefined;

    // Check for ref: prefix in selectors first (instant lookup, no waiting)
    for (const selector of selectorList) {
      if (selector.startsWith('ref:')) {
        const ref = selector.slice(4); // Extract "e4" from "ref:e4"
        const backendNodeId = this.refMap.get(ref);
        if (!backendNodeId) {
          continue; // Try next selector in list
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
            this._lastMatchedSelector = selector;
            return {
              nodeId: pushResult.nodeIds[0],
              backendNodeId,
              selector,
              waitedMs: 0,
            };
          }
        } catch {}
      }
    }

    // Stale ref recovery: if all selectors were refs and none worked, try matching by role+name
    if (selectorList.every((s) => s.startsWith('ref:')) && this.lastSnapshot) {
      for (const selector of selectorList) {
        const ref = selector.slice(4);
        const originalElement = this.lastSnapshot.interactiveElements.find((e) => e.ref === ref);
        if (!originalElement) continue;

        // Take a fresh snapshot to find matching element
        const freshSnapshot = await this.snapshot();
        const match = freshSnapshot.interactiveElements.find(
          (e) => e.role === originalElement.role && e.name === originalElement.name
        );

        if (match) {
          const newBackendNodeId = this.refMap.get(match.ref);
          if (newBackendNodeId) {
            try {
              await this.ensureRootNode();
              const pushResult = await this.cdp.send<{ nodeIds: number[] }>(
                'DOM.pushNodesByBackendIdsToFrontend',
                { backendNodeIds: [newBackendNodeId] }
              );
              if (pushResult.nodeIds?.[0]) {
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

    // Filter out ref: selectors for runtime waiting/querying.
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

    const specialSelectorMatch = await this.resolveSpecialSelector(result.selector);
    if (specialSelectorMatch) {
      this._lastMatchedSelector = result.selector;
      return {
        ...specialSelectorMatch,
        waitedMs: result.waitedMs,
      };
    }

    // Get the node using deep query (pierces shadow DOM)
    await this.ensureRootNode();

    // First try standard querySelector (faster for non-shadow DOM)
    const queryResult = await this.cdp.send<{ nodeId: number }>('DOM.querySelector', {
      nodeId: this.rootNodeId!,
      selector: result.selector,
    });

    if (queryResult.nodeId) {
      // Get backend node ID
      const describeResult = await this.cdp.send<{ node: { backendNodeId: number } }>(
        'DOM.describeNode',
        { nodeId: queryResult.nodeId }
      );

      this._lastMatchedSelector = result.selector;
      return {
        nodeId: queryResult.nodeId,
        backendNodeId: describeResult.node.backendNodeId,
        selector: result.selector,
        waitedMs: result.waitedMs,
      };
    }

    // Fall back to deep query for shadow DOM elements
    const deepQueryResult = await this.evaluateInFrame<{ result: RemoteObject }>(
      `(() => {
        ${DEEP_QUERY_SCRIPT}
        return deepQuery(${JSON.stringify(result.selector)});
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

    this._lastMatchedSelector = result.selector;
    return {
      nodeId: nodeResult.nodeId,
      backendNodeId: describeResult.node.backendNodeId,
      selector: result.selector,
      waitedMs: result.waitedMs,
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

  private async tryClickAssociatedLabel(objectId: string): Promise<boolean> {
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
      await this.clickElement(labelNodeId);
      return true;
    } catch {
      return false;
    }
  }

  private async tryToggleViaLabel(objectId: string, desiredChecked: boolean): Promise<boolean> {
    if (!(await this.tryClickAssociatedLabel(objectId))) {
      return false;
    }

    return (await this.readCheckedState(objectId)) === desiredChecked;
  }

  /**
   * Ensure we have a valid root node ID
   */
  private async ensureRootNode(): Promise<void> {
    if (this.rootNodeId) return;

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
   * Falls back to JS this.click() if CDP mouse dispatch fails.
   */
  private async clickElement(nodeId: number): Promise<void> {
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

    // Sequential mouse events (Playwright pattern)
    try {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'none',
        buttons: 0,
        modifiers: 0,
      });
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
        modifiers: 0,
      });
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
        modifiers: 0,
      });
    } catch {
      // Fallback: JS click if CDP mouse dispatch fails
      await this.cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function() { this.click(); }',
      });
    }

    // Force a round-trip to ensure all synchronous event handlers
    // triggered by the click have completed before we return
    await this.cdp.send('Runtime.evaluate', { expression: '0' });
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

  private async dispatchKeyDefinition(def: KeyDefinition, modifierBitmask = 0): Promise<void> {
    const downParams: Record<string, unknown> = {
      type: def.text !== undefined ? 'keyDown' : 'rawKeyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      modifiers: modifierBitmask,
      autoRepeat: false,
      location: def.location ?? 0,
      isKeypad: false,
    };

    if (def.text !== undefined) {
      downParams['text'] = def.text;
      downParams['unmodifiedText'] = def.text;
    }

    await this.cdp.send('Input.dispatchKeyEvent', downParams);
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      modifiers: modifierBitmask,
      location: def.location ?? 0,
    });
  }

  private async dispatchKey(key: string): Promise<void> {
    const def = US_KEYBOARD[key];
    if (def) {
      await this.dispatchKeyDefinition(def);
      return;
    }

    if (key.length === 1) {
      await this.cdp.send('Input.insertText', { text: key });
      return;
    }

    await this.dispatchKeyDefinition({ key, code: key, keyCode: 0 });
  }

  private async dispatchKeyWithModifiers(key: string, modifiers: ModifierKey[]): Promise<void> {
    const mask = computeModifierBitmask(modifiers);

    // Press modifier keys down
    for (const mod of modifiers) {
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: mod,
        code: MODIFIER_CODES[mod],
        windowsVirtualKeyCode: MODIFIER_KEY_CODES[mod],
        modifiers: mask,
        location: 1,
      });
    }

    // Dispatch the main key with modifiers held
    const def = US_KEYBOARD[key];
    if (def) {
      await this.dispatchKeyDefinition(def, mask);
    } else if (key.length === 1) {
      // For single characters with modifiers, use dispatchKeyEvent instead of insertText
      // so the modifiers are included in the event
      await this.dispatchKeyDefinition({ key, code: key, keyCode: 0, text: key }, mask);
    } else {
      await this.dispatchKeyDefinition({ key, code: key, keyCode: 0 }, mask);
    }

    // Release modifier keys (reverse order)
    for (let i = modifiers.length - 1; i >= 0; i--) {
      const mod = modifiers[i]!;
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: mod,
        code: MODIFIER_CODES[mod],
        windowsVirtualKeyCode: MODIFIER_KEY_CODES[mod],
        modifiers: 0,
        location: 1,
      });
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
