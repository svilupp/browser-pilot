/**
 * Wait strategy implementations
 */

import type { CDPClient } from '../cdp/client.ts';

export type WaitState = 'visible' | 'hidden' | 'attached' | 'detached';

export interface WaitOptions {
  /** State to wait for */
  state?: WaitState;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Polling interval in milliseconds */
  pollInterval?: number;
}

export interface WaitResult {
  success: boolean;
  waitedMs: number;
}

/**
 * Check if an element is visible in the viewport
 */
async function isElementVisible(cdp: CDPClient, selector: string): Promise<boolean> {
  const result = await cdp.send<{ result: { value: boolean } }>('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none') return false;
      if (style.visibility === 'hidden') return false;
      if (parseFloat(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })()`,
    returnByValue: true,
  });

  return result.result.value === true;
}

/**
 * Check if an element exists in the DOM
 */
async function isElementAttached(cdp: CDPClient, selector: string): Promise<boolean> {
  const result = await cdp.send<{ result: { value: boolean } }>('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)}) !== null`,
    returnByValue: true,
  });

  return result.result.value === true;
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for an element to reach a specific state
 */
export async function waitForElement(
  cdp: CDPClient,
  selector: string,
  options: WaitOptions = {}
): Promise<WaitResult> {
  const { state = 'visible', timeout = 30000, pollInterval = 100 } = options;

  const startTime = Date.now();
  const deadline = startTime + timeout;

  while (Date.now() < deadline) {
    let conditionMet = false;

    switch (state) {
      case 'visible':
        conditionMet = await isElementVisible(cdp, selector);
        break;
      case 'hidden':
        conditionMet = !(await isElementVisible(cdp, selector));
        break;
      case 'attached':
        conditionMet = await isElementAttached(cdp, selector);
        break;
      case 'detached':
        conditionMet = !(await isElementAttached(cdp, selector));
        break;
    }

    if (conditionMet) {
      return { success: true, waitedMs: Date.now() - startTime };
    }

    await sleep(pollInterval);
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
  const { state = 'visible', timeout = 30000, pollInterval = 100 } = options;

  const startTime = Date.now();
  const deadline = startTime + timeout;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      let conditionMet = false;

      switch (state) {
        case 'visible':
          conditionMet = await isElementVisible(cdp, selector);
          break;
        case 'hidden':
          conditionMet = !(await isElementVisible(cdp, selector));
          break;
        case 'attached':
          conditionMet = await isElementAttached(cdp, selector);
          break;
        case 'detached':
          conditionMet = !(await isElementAttached(cdp, selector));
          break;
      }

      if (conditionMet) {
        return { success: true, selector, waitedMs: Date.now() - startTime };
      }
    }

    await sleep(pollInterval);
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
    pollUrl();
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
