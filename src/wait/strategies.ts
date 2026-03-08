/**
 * Wait strategy implementations
 */

import { buildSpecialSelectorPredicateExpression } from '../browser/special-selectors.ts';
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
        const el = deepQuery(${JSON.stringify(selector)});
        if (!el) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none') return false;
        if (style.visibility === 'hidden') return false;
        if (parseFloat(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
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
  const { timeout = 30000, allowSameDocument = true } = options;

  const startTime = Date.now();
  let startUrl: string;

  try {
    startUrl = await getCurrentUrl(cdp);
  } catch {
    // If we can't get the URL, still try to wait for events
    startUrl = '';
  }

  return new Promise<WaitResult>((resolve) => {
    let resolved = false;
    const cleanup: (() => void)[] = [];

    const done = (success: boolean) => {
      if (resolved) return;
      resolved = true;
      for (const fn of cleanup) fn();
      resolve({ success, waitedMs: Date.now() - startTime });
    };

    // Timeout handler
    const timer = setTimeout(() => done(false), timeout);
    cleanup.push(() => clearTimeout(timer));

    // Event: Full page load
    const onLoad = () => done(true);
    cdp.on('Page.loadEventFired', onLoad);
    cleanup.push(() => cdp.off('Page.loadEventFired', onLoad));

    // Event: Frame navigation (covers history.back/forward for cross-document)
    const onFrameNavigated = (params: Record<string, unknown>) => {
      const frame = params['frame'] as { url: string; parentId?: string } | undefined;
      // Only trigger for main frame (no parentId means main frame)
      if (frame && !frame.parentId && frame.url !== startUrl) {
        done(true);
      }
    };
    cdp.on('Page.frameNavigated', onFrameNavigated);
    cleanup.push(() => cdp.off('Page.frameNavigated', onFrameNavigated));

    // Event: Same-document navigation (pushState, anchors)
    if (allowSameDocument) {
      const onSameDoc = () => done(true);
      cdp.on('Page.navigatedWithinDocument', onSameDoc);
      cleanup.push(() => cdp.off('Page.navigatedWithinDocument', onSameDoc));
    }

    // Event: Network idle lifecycle (catches SPAs that don't fire loadEventFired)
    const onLifecycle = (params: Record<string, unknown>) => {
      if (params['name'] === 'networkIdle') {
        done(true);
      }
    };
    cdp.on('Page.lifecycleEvent', onLifecycle);
    cleanup.push(() => cdp.off('Page.lifecycleEvent', onLifecycle));

    // Fallback: URL polling (catches edge cases)
    const pollUrl = async () => {
      while (!resolved && Date.now() < startTime + timeout) {
        await sleep(100);
        if (resolved) return;
        try {
          const currentUrl = await getCurrentUrl(cdp);
          if (startUrl && currentUrl !== startUrl) {
            done(true);
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
