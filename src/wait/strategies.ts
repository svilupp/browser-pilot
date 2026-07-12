/**
 * Wait strategy implementations
 */

import { buildSpecialSelectorPredicateExpression } from '../browser/special-selectors.ts';
import type {
  NavigationMilestone,
  ReadinessDiagnostics,
  ReadyCondition,
  WaitForReadyOptions,
} from '../browser/types.ts';
import type { CDPClient } from '../cdp/client.ts';

export type WaitState = 'visible' | 'hidden' | 'attached' | 'detached';

export interface WaitOptions {
  /** State to wait for */
  state?: WaitState;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Polling interval in milliseconds */
  pollInterval?: number;
  /** Execution context ID for iframe evaluation */
  contextId?: number;
}

export interface WaitResult {
  success: boolean;
  waitedMs: number;
  milestone?: NavigationMilestone;
  diagnostics?: ReadinessDiagnostics;
}

/**
 * Deep query script that pierces shadow DOM boundaries
 * Searches the document and all shadow roots recursively
 * Exported for use in page.ts and other modules
 */
export const DEEP_QUERY_SCRIPT = `
function deepQuery(selector, root = document) {
  // Try direct query first (fastest path)
  let el = root.querySelector(selector);
  if (el) return el;

  // Search in shadow roots recursively
  const searchShadows = (node) => {
    // Check if this node has a shadow root
    if (node.shadowRoot) {
      el = node.shadowRoot.querySelector(selector);
      if (el) return el;
      // Search children of shadow root
      for (const child of node.shadowRoot.querySelectorAll('*')) {
        el = searchShadows(child);
        if (el) return el;
      }
    }
    // Search children that might have shadow roots
    for (const child of node.querySelectorAll('*')) {
      if (child.shadowRoot) {
        el = searchShadows(child);
        if (el) return el;
      }
    }
    return null;
  };

  return searchShadows(root);
}
`;

/**
 * Shared visibility predicate, as a JS function declaration string so it can be
 * inlined into `Runtime.evaluate` expressions. Defines `bpElementVisible(el)`:
 * an element is visible when it exists AND its computed style is not
 * display:none / visibility:hidden / opacity:0 AND its bounding box has
 * non-zero width and height. Reused by the wait subsystem and
 * `Page.elementState` so the notion of "visible" stays identical across both.
 * Exported for use in page.ts and other modules.
 */
export const VISIBLE_PREDICATE_SCRIPT = `
function bpElementVisible(el) {
  if (!el) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (parseFloat(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
`;

/**
 * Check if an element is visible in the viewport
 * Pierces shadow DOM boundaries automatically
 */
async function isElementVisible(
  cdp: CDPClient,
  selector: string,
  contextId?: number
): Promise<boolean> {
  const specialExpression = buildSpecialSelectorPredicateExpression(selector);
  const params: Record<string, unknown> = {
    expression:
      specialExpression ??
      `(() => {
        ${DEEP_QUERY_SCRIPT}
        ${VISIBLE_PREDICATE_SCRIPT}
        return bpElementVisible(deepQuery(${JSON.stringify(selector)}));
      })()`,
    returnByValue: true,
  };

  if (contextId !== undefined) {
    params['contextId'] = contextId;
  }

  const result = await cdp.send<{ result: { value: boolean } }>('Runtime.evaluate', params);

  return result.result.value === true;
}

/**
 * Check if an element exists in the DOM
 * Pierces shadow DOM boundaries automatically
 */
async function isElementAttached(
  cdp: CDPClient,
  selector: string,
  contextId?: number
): Promise<boolean> {
  const specialExpression = buildSpecialSelectorPredicateExpression(selector, {
    includeHidden: true,
  });
  const params: Record<string, unknown> = {
    expression:
      specialExpression ??
      `(() => {
        ${DEEP_QUERY_SCRIPT}
        return deepQuery(${JSON.stringify(selector)}) !== null;
      })()`,
    returnByValue: true,
  };

  if (contextId !== undefined) {
    params['contextId'] = contextId;
  }

  const result = await cdp.send<{ result: { value: boolean } }>('Runtime.evaluate', params);

  return result.result.value === true;
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if the page is likely static (no pending DOM changes).
 * Returns true if the page appears settled and no mutations are observed.
 * Returns false (= page is dynamic) if:
 * - document.readyState is not 'complete'
 * - DOM mutations are observed within the observation window
 * - Page has been loaded recently (within 500ms of DOMContentLoaded)
 */
async function isPageStatic(
  cdp: CDPClient,
  windowMs: number = 200,
  contextId?: number
): Promise<boolean> {
  const params: Record<string, unknown> = {
    expression: `new Promise(resolve => {
      // If page is still loading, it's not static
      if (document.readyState !== 'complete') { resolve(false); return; }
      // Check for recent page load (navigationStart within last 1s = page just loaded)
      try {
        var nav = performance.getEntriesByType('navigation')[0];
        if (nav && (performance.now() - nav.loadEventEnd) < 500) { resolve(false); return; }
      } catch(e) {}
      // Observe for DOM mutations
      var seen = false;
      var obs = new MutationObserver(function() { seen = true; });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      setTimeout(function() { obs.disconnect(); resolve(!seen); }, ${windowMs});
    })`,
    returnByValue: true,
    awaitPromise: true,
  };
  if (contextId !== undefined) params['contextId'] = contextId;

  try {
    const result = await cdp.send<{ result: { value: boolean } }>('Runtime.evaluate', params);
    return result.result.value === true;
  } catch {
    return false; // Assume dynamic if we can't check
  }
}

/**
 * Wait for an element to reach a specific state.
 * Uses fast-fail: if the element is not found on a static page (no DOM mutations),
 * returns early instead of polling for the full timeout.
 */
export async function waitForElement(
  cdp: CDPClient,
  selector: string,
  options: WaitOptions = {}
): Promise<WaitResult> {
  const { state = 'visible', timeout = 30000, pollInterval = 100, contextId } = options;

  const startTime = Date.now();
  const deadline = startTime + timeout;

  const checkCondition = async (): Promise<boolean> => {
    switch (state) {
      case 'visible':
        return isElementVisible(cdp, selector, contextId);
      case 'hidden':
        return !(await isElementVisible(cdp, selector, contextId));
      case 'attached':
        return isElementAttached(cdp, selector, contextId);
      case 'detached':
        return !(await isElementAttached(cdp, selector, contextId));
      default: {
        const _exhaustive: never = state;
        throw new Error(`Unhandled wait state: ${_exhaustive}`);
      }
    }
  };

  // Immediate check
  if (await checkCondition()) {
    return { success: true, waitedMs: Date.now() - startTime };
  }

  // For waiting-for-absence states (hidden/detached), skip fast-fail
  // since the element is present but we're waiting for it to go away
  const waitingForPresence = state === 'visible' || state === 'attached';

  // Fast-fail: if the page is static and we're waiting for an element to appear,
  // no point polling for the full timeout
  if (waitingForPresence && timeout >= 300) {
    const pageStatic = await isPageStatic(cdp, 200, contextId);
    if (pageStatic) {
      // DOM is static — one final check then bail
      if (await checkCondition()) {
        return { success: true, waitedMs: Date.now() - startTime };
      }
      return { success: false, waitedMs: Date.now() - startTime };
    }
  }

  // Standard polling loop for dynamic pages
  while (Date.now() < deadline) {
    await sleep(pollInterval);

    if (await checkCondition()) {
      return { success: true, waitedMs: Date.now() - startTime };
    }
  }

  return { success: false, waitedMs: Date.now() - startTime };
}

/**
 * Wait for any of the given selectors to match
 * Returns the selector that matched first
 */
export async function waitForAnyElement(
  cdp: CDPClient,
  selectors: string[],
  options: WaitOptions = {}
): Promise<{ success: boolean; selector?: string; waitedMs: number }> {
  const { state = 'visible', timeout = 30000, pollInterval = 100, contextId } = options;

  const startTime = Date.now();
  const deadline = startTime + timeout;

  const checkSelector = async (selector: string): Promise<boolean> => {
    switch (state) {
      case 'visible':
        return isElementVisible(cdp, selector, contextId);
      case 'hidden':
        return !(await isElementVisible(cdp, selector, contextId));
      case 'attached':
        return isElementAttached(cdp, selector, contextId);
      case 'detached':
        return !(await isElementAttached(cdp, selector, contextId));
      default: {
        const _exhaustive: never = state;
        throw new Error(`Unhandled wait state: ${_exhaustive}`);
      }
    }
  };

  // Immediate check
  for (const selector of selectors) {
    if (await checkSelector(selector)) {
      return { success: true, selector, waitedMs: Date.now() - startTime };
    }
  }

  // Fast-fail for presence waits on static pages
  const waitingForPresence = state === 'visible' || state === 'attached';
  if (waitingForPresence && timeout >= 300) {
    const pageStatic = await isPageStatic(cdp, 200, contextId);
    if (pageStatic) {
      for (const selector of selectors) {
        if (await checkSelector(selector)) {
          return { success: true, selector, waitedMs: Date.now() - startTime };
        }
      }
      return { success: false, waitedMs: Date.now() - startTime };
    }
  }

  // Standard polling loop
  while (Date.now() < deadline) {
    await sleep(pollInterval);

    for (const selector of selectors) {
      if (await checkSelector(selector)) {
        return { success: true, selector, waitedMs: Date.now() - startTime };
      }
    }
  }

  return { success: false, waitedMs: Date.now() - startTime };
}

export interface NavigationOptions {
  /** Timeout in milliseconds */
  timeout?: number;
  /** Include same-document navigation (pushState, anchors) */
  allowSameDocument?: boolean;
  /** Lifecycle milestone correlated to the main-frame navigation. */
  waitUntil?: NavigationMilestone;
  /** Snapshot refs can be checked by backend node ID when supplied by Page. */
  refMap?: Record<string, number>;
  /** Optional destination URL used to reject late events from the old document. */
  expectedUrl?: string;
}

async function getMainFrame(cdp: CDPClient): Promise<{
  id?: string;
  loaderId?: string;
}> {
  try {
    const result = await cdp.send<{
      frameTree?: { frame?: { id?: string; loaderId?: string } };
    }>('Page.getFrameTree');
    return {
      id: result.frameTree?.frame?.id,
      loaderId: result.frameTree?.frame?.loaderId,
    };
  } catch {
    return {};
  }
}

/**
 * Get the current page URL
 */
async function getCurrentUrl(cdp: CDPClient): Promise<string> {
  const result = await cdp.send<{ result: { value: string } }>('Runtime.evaluate', {
    expression: 'location.href',
    returnByValue: true,
  });
  return result.result.value;
}

/**
 * Wait for navigation to complete using multi-signal detection
 * Listens for:
 * - Page.loadEventFired: Full page load
 * - Page.frameNavigated: Frame navigation (includes history.back/forward)
 * - Page.navigatedWithinDocument: Same-document navigation (pushState, anchors)
 * Also polls for URL changes as a fallback
 */
export async function waitForNavigation(
  cdp: CDPClient,
  options: NavigationOptions = {}
): Promise<WaitResult> {
  const { timeout = 30000, allowSameDocument = true, waitUntil = 'load', expectedUrl } = options;

  const startTime = Date.now();
  let startUrl = '';
  let startLoaderId: string | undefined;
  const initialUrl = getCurrentUrl(cdp).catch(() => '');
  const initialFrame = getMainFrame(cdp);

  return new Promise<WaitResult>((resolve) => {
    let resolved = false;
    let navigationStarted = false;
    let metadataReady = false;
    let mainFrameId: string | undefined;
    let navigationLoaderId: string | undefined;
    let lastMilestone: NavigationMilestone | undefined;
    let pendingMilestone: NavigationMilestone | undefined;
    const pendingLifecycleEvents: Record<string, unknown>[] = [];
    const cleanup: (() => void)[] = [];

    const done = (success: boolean, milestone?: NavigationMilestone) => {
      if (resolved) return;
      resolved = true;
      lastMilestone = milestone ?? lastMilestone;
      for (const fn of cleanup) fn();
      resolve({ success, waitedMs: Date.now() - startTime, milestone: lastMilestone });
    };

    const isMainFrame = (frameId?: unknown, parentId?: unknown): boolean => {
      if (mainFrameId) return frameId === mainFrameId;
      return parentId === undefined || parentId === null;
    };

    const recordNavigation = (loaderId?: unknown) => {
      navigationStarted = true;
      if (typeof loaderId === 'string' && loaderId !== startLoaderId) {
        navigationLoaderId = loaderId;
      }
    };

    const reached = (milestone: NavigationMilestone): boolean => {
      const order: NavigationMilestone[] = ['commit', 'domcontentloaded', 'load', 'networkidle'];
      return order.indexOf(milestone) >= order.indexOf(waitUntil);
    };

    const mark = (milestone: NavigationMilestone) => {
      if (reached(milestone)) done(true, milestone);
      else lastMilestone = milestone;
    };

    const isBackForwardCacheRestore = (name: string): boolean =>
      name.toLowerCase().replace(/[_-]/g, '') === 'backforwardcacherestore';

    const bufferMilestone = (milestone: NavigationMilestone) => {
      const order: NavigationMilestone[] = ['commit', 'domcontentloaded', 'load', 'networkidle'];
      if (!pendingMilestone || order.indexOf(milestone) > order.indexOf(pendingMilestone)) {
        pendingMilestone = milestone;
      }
    };

    // Timeout handler
    const timer = setTimeout(() => done(false), timeout);
    cleanup.push(() => clearTimeout(timer));

    // Main-target load events are scoped by the Page's CDP view. They still
    // require an observed navigation so a stale load event from the previous
    // document cannot satisfy a new wait.
    const onLoad = () => {
      if (!navigationStarted) return;
      if (!metadataReady) {
        bufferMilestone('load');
        return;
      }
      mark('load');
    };
    cdp.on('Page.loadEventFired', onLoad);
    cleanup.push(() => cdp.off('Page.loadEventFired', onLoad));

    const onDomContentLoaded = () => {
      if (!navigationStarted) return;
      if (!metadataReady) {
        bufferMilestone('domcontentloaded');
        return;
      }
      mark('domcontentloaded');
    };
    cdp.on('Page.domContentEventFired', onDomContentLoaded);
    cleanup.push(() => cdp.off('Page.domContentEventFired', onDomContentLoaded));

    // A main-frame frameNavigated is the commit boundary. Child frame events
    // are intentionally ignored, even when they carry a newer loaderId.
    const onFrameNavigated = (params: Record<string, unknown>) => {
      const frame = params['frame'] as
        | { id?: string; url?: string; parentId?: string; loaderId?: string }
        | undefined;
      if (!frame || !isMainFrame(frame.id, frame.parentId)) return;
      if (expectedUrl && frame.url && frame.url !== expectedUrl) return;
      if (isBackForwardCacheRestore(String(params['type'] ?? ''))) {
        mainFrameId = frame.id ?? mainFrameId;
        recordNavigation(frame.loaderId);
        if (!metadataReady) bufferMilestone('load');
        else mark('load');
        return;
      }
      if (frame.loaderId && startLoaderId && frame.loaderId === startLoaderId) {
        // A BFCache history restore can reuse the starting document's loader.
        // With an exact expected URL, the main-frame frameNavigated event is
        // sufficient to treat the restored document as loaded.
        if (expectedUrl && frame.url === expectedUrl) {
          mainFrameId = frame.id ?? mainFrameId;
          recordNavigation(frame.loaderId);
          mark('load');
        }
        return;
      }
      mainFrameId = frame.id ?? mainFrameId;
      recordNavigation(frame.loaderId);
      if (frame.loaderId && frame.loaderId !== startLoaderId) navigationLoaderId = frame.loaderId;
      mark('commit');
    };
    cdp.on('Page.frameNavigated', onFrameNavigated);
    cleanup.push(() => cdp.off('Page.frameNavigated', onFrameNavigated));

    // Event: Same-document navigation (pushState, anchors)
    if (allowSameDocument) {
      const onSameDoc = (params: Record<string, unknown>) => {
        if (!isMainFrame(params['frameId'])) return;
        recordNavigation();
        // Same-document navigation has no new DOMContentLoaded/load lifecycle;
        // commit is the only meaningful milestone for it.
        mark('commit');
      };
      cdp.on('Page.navigatedWithinDocument', onSameDoc);
      cleanup.push(() => cdp.off('Page.navigatedWithinDocument', onSameDoc));
    }

    // Lifecycle events are accepted only for the main frame and the loader
    // observed at commit. This prevents a busy child frame from satisfying a
    // main-page networkidle wait.
    const onLifecycle = (params: Record<string, unknown>) => {
      if (!metadataReady) {
        // Lifecycle events include a frameId, but they can arrive before the
        // initial frame-tree response identifies the main frame. Keep them
        // until that identity is known so a child frame cannot win the wait.
        pendingLifecycleEvents.push(params);
        return;
      }
      if (!mainFrameId || params['frameId'] !== mainFrameId) return;
      const loaderId = params['loaderId'];
      if (navigationLoaderId && loaderId && loaderId !== navigationLoaderId) return;
      if (!navigationStarted && typeof loaderId === 'string' && loaderId !== startLoaderId) {
        recordNavigation(loaderId);
      }
      const name = String(params['name'] ?? '');
      if (isBackForwardCacheRestore(name)) {
        // BFCache restores do not necessarily emit a new loader or the normal
        // DOMContentLoaded/load pair. The event is main-frame scoped above and
        // therefore is safe to use as the load milestone.
        if (!navigationStarted) recordNavigation(loaderId);
        mark('load');
        return;
      }
      if (!navigationStarted) return;
      if (name === 'DOMContentLoaded') mark('domcontentloaded');
      else if (name === 'load') mark('load');
      else if (name === 'networkIdle') mark('networkidle');
    };
    cdp.on('Page.lifecycleEvent', onLifecycle);
    cleanup.push(() => cdp.off('Page.lifecycleEvent', onLifecycle));

    const replayPendingMilestones = () => {
      if (!metadataReady || resolved) return;

      const lifecycleEvents = pendingLifecycleEvents.splice(0);
      for (const params of lifecycleEvents) {
        onLifecycle(params);
        if (resolved) return;
      }

      if (pendingMilestone) {
        const milestone = pendingMilestone;
        pendingMilestone = undefined;
        mark(milestone);
      }
    };

    // The metadata requests were started before event registration, so their
    // CDP messages are already queued before the caller triggers navigation.
    // The handlers above are nevertheless installed first from the caller's
    // perspective, preserving the arm-before-trigger contract.
    void initialUrl.then((url) => {
      startUrl = url;
    });
    void initialFrame.then((frame) => {
      if (!mainFrameId) mainFrameId = frame.id;
      // If the frame-tree response raced with navigation, it may already
      // describe the new document. Keep the loader observed at the main-frame
      // commit as the navigation loader instead of mistaking it for the
      // starting loader.
      if (frame.loaderId !== navigationLoaderId) startLoaderId = frame.loaderId;
      metadataReady = true;
      replayPendingMilestones();
    });

    // Fallback: URL polling (catches edge cases)
    const pollUrl = async () => {
      while (!resolved && Date.now() < startTime + timeout) {
        await sleep(100);
        if (resolved) return;
        try {
          const currentUrl = await getCurrentUrl(cdp);
          const destinationReached = expectedUrl
            ? currentUrl === expectedUrl
            : startUrl && currentUrl !== startUrl;
          if (destinationReached) {
            recordNavigation();
            mark('commit');
            return;
          }
        } catch {
          // Ignore errors during polling
        }
      }
    };
    void pollUrl();
  });
}

interface ReadyCheckResult {
  matched: boolean;
  label: string;
}

async function evaluateReadyPredicate(
  cdp: CDPClient,
  predicate: string | (() => unknown),
  contextId?: number
): Promise<boolean> {
  const expression = typeof predicate === 'function' ? `(${predicate.toString()})()` : predicate;
  const params: Record<string, unknown> = { expression, returnByValue: true };
  if (contextId !== undefined) params['contextId'] = contextId;
  try {
    const result = await cdp.send<{ result: { value?: unknown } }>('Runtime.evaluate', params);
    return result.result.value === true;
  } catch {
    return false;
  }
}

async function checkReadyCondition(
  cdp: CDPClient,
  condition: ReadyCondition,
  options: { contextId?: number; refMap?: Record<string, number> }
): Promise<ReadyCheckResult> {
  if (typeof condition === 'string') {
    const selector = condition;
    if (selector.startsWith('ref:') && options.refMap) {
      const backendNodeId = options.refMap[selector.slice(4)];
      if (backendNodeId !== undefined) {
        try {
          const pushed = await cdp.send<{ nodeIds?: number[] }>(
            'DOM.pushNodesByBackendIdsToFrontend',
            { backendNodeIds: [backendNodeId] }
          );
          const nodeId = pushed.nodeIds?.[0];
          if (nodeId) {
            const resolved = await cdp.send<{ object?: { objectId?: string } }>('DOM.resolveNode', {
              nodeId,
            });
            if (resolved.object?.objectId) {
              const checked = await cdp.send<{ result: { value?: boolean } }>(
                'Runtime.callFunctionOn',
                {
                  objectId: resolved.object.objectId,
                  functionDeclaration: `function() {
                    if (!this || !this.isConnected) return false;
                    var style = getComputedStyle(this);
                    var rect = this.getBoundingClientRect();
                    return style.display !== 'none' && style.visibility !== 'hidden' &&
                      parseFloat(style.opacity || '1') !== 0 && rect.width > 0 && rect.height > 0;
                  }`,
                  returnByValue: true,
                }
              );
              return { matched: checked.result.value === true, label: selector };
            }
          }
        } catch {
          // A stale ref remains unmet; callers can use a selector/role fallback.
        }
      }
      return { matched: false, label: selector };
    }
    try {
      const matched = await isElementVisible(cdp, selector, options.contextId);
      return { matched, label: `visible ${selector}` };
    } catch {
      return { matched: false, label: `visible ${selector}` };
    }
  }

  if (condition.selector !== undefined) {
    const selectors = Array.isArray(condition.selector) ? condition.selector : [condition.selector];
    for (const selector of selectors) {
      const result = await checkReadyCondition(cdp, selector, options);
      if (result.matched) return { matched: true, label: `visible ${selector}` };
    }
    return { matched: false, label: `visible ${selectors.join(' or ')}` };
  }
  if (condition.url !== undefined) {
    const current = await getCurrentUrl(cdp).catch(() => '');
    return { matched: current.includes(condition.url), label: `url includes ${condition.url}` };
  }
  if (condition.predicate !== undefined) {
    return {
      matched: await evaluateReadyPredicate(cdp, condition.predicate, options.contextId),
      label: 'predicate',
    };
  }
  return { matched: false, label: 'empty readiness condition' };
}

async function readDomQuietFor(cdp: CDPClient, contextId?: number): Promise<number> {
  const params: Record<string, unknown> = {
    expression: `(() => {
      const key = '__browserPilotReadinessState';
      const state = globalThis[key] || (globalThis[key] = { lastMutation: performance.now() });
      if (!state.observer && document.documentElement) {
        state.observer = new MutationObserver(() => { state.lastMutation = performance.now(); });
        state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      }
      return performance.now() - state.lastMutation;
    })()`,
    returnByValue: true,
  };
  if (contextId !== undefined) params['contextId'] = contextId;
  try {
    const result = await cdp.send<{ result: { value?: number } }>('Runtime.evaluate', params);
    return typeof result.result.value === 'number' ? result.result.value : 0;
  } catch {
    return 0;
  }
}

async function clearDomQuietState(cdp: CDPClient, contextId?: number): Promise<void> {
  const params: Record<string, unknown> = {
    expression: `(() => {
      const state = globalThis.__browserPilotReadinessState;
      state?.observer?.disconnect?.();
      try { delete globalThis.__browserPilotReadinessState; } catch {}
    })()`,
    returnByValue: true,
  };
  if (contextId !== undefined) params['contextId'] = contextId;
  try {
    await cdp.send('Runtime.evaluate', params);
  } catch {}
}

/** Wait for SPA/application conditions after a browser navigation milestone. */
export async function waitForReady(
  cdp: CDPClient,
  options: WaitForReadyOptions & { refMap?: Record<string, number> } = {}
): Promise<WaitResult> {
  const timeout = options.timeout ?? 30000;
  const pollInterval = options.pollInterval ?? 100;
  const startTime = Date.now();
  const deadline = startTime + timeout;
  const anyConditions = options.any ?? [];
  const allConditions = options.all ?? [];
  const loadingSelectors = options.loadingHidden
    ? Array.isArray(options.loadingHidden)
      ? options.loadingHidden
      : [options.loadingHidden]
    : [];
  const quietFor = options.domQuietForMs ?? options.stableForMs ?? 0;
  let unmet: string[] = [];

  try {
    while (Date.now() <= deadline) {
      const checks: ReadyCheckResult[] = [];
      if (options.url !== undefined)
        checks.push(await checkReadyCondition(cdp, { url: options.url }, options));
      if (options.predicate !== undefined)
        checks.push(await checkReadyCondition(cdp, { predicate: options.predicate }, options));
      if (anyConditions.length > 0) {
        const results = await Promise.all(
          anyConditions.map((condition) => checkReadyCondition(cdp, condition, options))
        );
        checks.push({
          matched: results.some((result) => result.matched),
          label: `any(${results.map((r) => r.label).join(', ')})`,
        });
      }
      if (allConditions.length > 0)
        checks.push(
          ...(await Promise.all(
            allConditions.map((condition) => checkReadyCondition(cdp, condition, options))
          ))
        );
      for (const selector of loadingSelectors) {
        const hidden = !(await isElementVisible(cdp, selector, options.contextId).catch(
          () => false
        ));
        checks.push({ matched: hidden, label: `loading hidden ${selector}` });
      }
      const missing = checks.filter((check) => !check.matched).map((check) => check.label);
      const quiet = quietFor <= 0 || (await readDomQuietFor(cdp, options.contextId)) >= quietFor;
      if (!quiet) missing.push(`DOM quiet for ${quietFor}ms`);
      unmet = missing;
      if (missing.length === 0) {
        return { success: true, waitedMs: Date.now() - startTime };
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(pollInterval, Math.max(0, deadline - Date.now())));
    }
    return {
      success: false,
      waitedMs: Date.now() - startTime,
      diagnostics: {
        ready: false,
        waitedMs: Date.now() - startTime,
        unmetConditions: unmet,
        checkedAt: new Date().toISOString(),
      },
    };
  } finally {
    if (quietFor > 0) await clearDomQuietState(cdp, options.contextId);
  }
}

/**
 * Wait for network to be idle (no requests in flight for a given duration)
 */
export async function waitForNetworkIdle(
  cdp: CDPClient,
  options: { timeout?: number; idleTime?: number } = {}
): Promise<WaitResult> {
  const { timeout = 30000, idleTime = 500 } = options;
  const startTime = Date.now();

  // Enable network events if not already enabled
  await cdp.send('Network.enable');

  return new Promise<WaitResult>((resolve) => {
    let inFlight = 0;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const timeoutTimer = setTimeout(() => {
      cleanup();
      resolve({ success: false, waitedMs: Date.now() - startTime });
    }, timeout);

    const checkIdle = () => {
      if (inFlight === 0) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          cleanup();
          resolve({ success: true, waitedMs: Date.now() - startTime });
        }, idleTime);
      }
    };

    const onRequestStart = () => {
      inFlight++;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const onRequestEnd = () => {
      inFlight = Math.max(0, inFlight - 1);
      checkIdle();
    };

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (idleTimer) clearTimeout(idleTimer);
      cdp.off('Network.requestWillBeSent', onRequestStart);
      cdp.off('Network.loadingFinished', onRequestEnd);
      cdp.off('Network.loadingFailed', onRequestEnd);
    };

    cdp.on('Network.requestWillBeSent', onRequestStart);
    cdp.on('Network.loadingFinished', onRequestEnd);
    cdp.on('Network.loadingFailed', onRequestEnd);

    // Start initial idle check
    checkIdle();
  });
}
