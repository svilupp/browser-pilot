/**
 * Actionability checks for browser automation
 *
 * Implements Playwright-style pre-action checks using pure CDP Runtime.callFunctionOn calls.
 * Each check is a JS function string executed against the target element's remote object.
 */

import type { CDPClient } from '../cdp/client.ts';

// ============ Types ============

export type ActionabilityCheck = 'visible' | 'enabled' | 'stable' | 'hitTarget' | 'editable';

export interface ActionabilityResult {
  actionable: boolean;
  reason?: string;
  failureType?: ActionabilityCheck;
  coveringElement?: { tag: string; id?: string; className?: string };
}

export class ActionabilityError extends Error {
  failureType?: ActionabilityCheck;
  coveringElement?: ActionabilityResult['coveringElement'];

  constructor(
    message: string,
    failureType?: ActionabilityCheck,
    coveringElement?: ActionabilityResult['coveringElement']
  ) {
    super(message);
    this.name = 'ActionabilityError';
    this.failureType = failureType;
    this.coveringElement = coveringElement;
  }
}

export interface ActionabilityOptions {
  /** Overall timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Click coordinates needed for hitTarget check */
  coordinates?: { x: number; y: number };
}

// ============ Check Scripts ============

/**
 * Visible check:
 * - Element.checkVisibility() for display:none, visibility:hidden, content-visibility
 * - style.visibility !== 'visible' → not visible
 * - getBoundingClientRect() width > 0 AND height > 0
 * - display:contents → recursively check children
 */
export const CHECK_VISIBLE = `function() {
  // checkVisibility handles display:none, visibility:hidden, content-visibility up the tree
  if (typeof this.checkVisibility === 'function' && !this.checkVisibility()) {
    return { actionable: false, reason: 'Element is not visible (checkVisibility failed). Try scrolling or check if a prior action is needed to reveal it.' };
  }

  var style = getComputedStyle(this);

  if (style.visibility !== 'visible') {
    return { actionable: false, reason: 'Element has visibility: ' + style.visibility + '. Try scrolling or check if a prior action is needed to reveal it.' };
  }

  // display:contents elements have no box themselves — check children
  if (style.display === 'contents') {
    var children = this.children;
    if (children.length === 0) {
      return { actionable: false, reason: 'Element has display:contents with no children. Try scrolling or check if a prior action is needed to reveal it.' };
    }
    for (var i = 0; i < children.length; i++) {
      var childRect = children[i].getBoundingClientRect();
      if (childRect.width > 0 && childRect.height > 0) {
        return { actionable: true };
      }
    }
    return { actionable: false, reason: 'Element has display:contents but no visible children. Try scrolling or check if a prior action is needed to reveal it.' };
  }

  var rect = this.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return { actionable: false, reason: 'Element has zero size (' + rect.width + 'x' + rect.height + '). Try scrolling or check if a prior action is needed to reveal it.' };
  }

  return { actionable: true };
}`;

/**
 * Enabled check:
 * - Native disabled attr on BUTTON/INPUT/SELECT/TEXTAREA/OPTION/OPTGROUP
 * - Ancestor FIELDSET[disabled] (except first <legend> children)
 * - aria-disabled="true" walking UP the entire ancestor chain (crosses shadow DOM)
 */
export const CHECK_ENABLED = `function() {
  // Native disabled property
  var disableable = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'OPTGROUP'];
  if (disableable.indexOf(this.tagName) !== -1 && this.disabled) {
    return { actionable: false, reason: 'Element is disabled. Check if a prerequisite field needs to be filled first.' };
  }

  // Check ancestor FIELDSET[disabled]
  var parent = this.parentElement;
  while (parent) {
    if (parent.tagName === 'FIELDSET' && parent.disabled) {
      // Exception: elements inside the first <legend> of a disabled fieldset are NOT disabled
      var legend = parent.querySelector(':scope > legend');
      if (!legend || !legend.contains(this)) {
        return { actionable: false, reason: 'Element is inside a disabled fieldset. Check if a prerequisite field needs to be filled first.' };
      }
    }
    parent = parent.parentElement;
  }

  // aria-disabled="true" walking up ancestor chain (crosses shadow DOM)
  var node = this;
  while (node) {
    if (node.nodeType === 1 && node.getAttribute && node.getAttribute('aria-disabled') === 'true') {
      return { actionable: false, reason: 'Element or ancestor has aria-disabled="true". Check if a prerequisite field needs to be filled first.' };
    }
    if (node.parentElement) {
      node = node.parentElement;
    } else if (node.getRootNode && node.getRootNode() !== node) {
      // Cross shadow DOM boundary
      var root = node.getRootNode();
      node = root.host || null;
    } else {
      break;
    }
  }

  return { actionable: true };
}`;

/**
 * Stable check (animation detection):
 * - RAF-based position comparison — 2 consecutive identical frames
 * - Must return a Promise (use awaitPromise: true)
 * - Max 30 frames safety limit
 * - Zero tolerance — exact floating-point equality on x, y, width, height
 */
export const CHECK_STABLE = `function() {
  var self = this;
  return new Promise(function(resolve) {
    // If tab is backgrounded, RAF won't fire reliably — skip stability check
    if (document.visibilityState === 'hidden') {
      var rect = self.getBoundingClientRect();
      resolve({ actionable: rect.width > 0 && rect.height > 0 });
      return;
    }

    var maxFrames = 30;
    var prev = null;
    var frame = 0;
    var resolved = false;

    var fallbackTimer = setTimeout(function() {
      if (!resolved) {
        resolved = true;
        resolve({ actionable: false, reason: 'Element stability check timed out (tab may be backgrounded)' });
      }
    }, 2000);

    function check() {
      if (resolved) return;
      frame++;
      if (frame > maxFrames) {
        resolved = true;
        clearTimeout(fallbackTimer);
        resolve({ actionable: false, reason: 'Element position not stable after ' + maxFrames + ' frames' });
        return;
      }

      var rect = self.getBoundingClientRect();
      var cur = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };

      if (prev !== null &&
          prev.x === cur.x && prev.y === cur.y &&
          prev.w === cur.w && prev.h === cur.h) {
        resolved = true;
        clearTimeout(fallbackTimer);
        resolve({ actionable: true });
        return;
      }

      prev = cur;
      requestAnimationFrame(check);
    }

    requestAnimationFrame(check);
  });
}`;

/**
 * Hit target check (element not covered):
 * - document.elementsFromPoint(x, y) at computed click center
 * - Walk through shadow roots: each root's elementsFromPoint checked
 * - Target must be the hit element OR an ancestor/descendant of it
 * - Report covering element tag + id/class on failure
 *
 * Takes x, y as arguments via callFunctionOn arguments.
 */
export const CHECK_HIT_TARGET = `function(x, y) {
  // Compute click center if coordinates not provided
  if (x === undefined || y === undefined) {
    var rect = this.getBoundingClientRect();
    x = rect.x + rect.width / 2;
    y = rect.y + rect.height / 2;
  }

  function checkPoint(root, px, py) {
    var method = root.elementsFromPoint || root.msElementsFromPoint;
    if (!method) return [];
    return method.call(root, px, py) || [];
  }

  // Follow only the top-most hit through nested shadow roots.
  // Accepting any hit in the stack creates false positives for covered elements.
  var root = document;
  var topHits = [];
  var seenRoots = [];
  while (root && seenRoots.indexOf(root) === -1) {
    seenRoots.push(root);
    var hits = checkPoint(root, x, y);
    if (!hits.length) break;
    var top = hits[0];
    topHits.push(top);
    if (top && top.shadowRoot) {
      root = top.shadowRoot;
      continue;
    }
    break;
  }

  // Target must be the top-most hit element or an ancestor/descendant
  for (var j = 0; j < topHits.length; j++) {
    var hit = topHits[j];
    if (hit === this || this.contains(hit) || hit.contains(this)) {
      return { actionable: true };
    }
  }

  // Report the covering element
  var top = topHits.length > 0 ? topHits[topHits.length - 1] : null;
  if (top) {
    return {
      actionable: false,
      reason: 'Element is covered by <' + top.tagName.toLowerCase() + '>' +
        (top.id ? '#' + top.id : '') +
        (top.className && typeof top.className === 'string' ? '.' + top.className.split(' ').join('.') : '') +
        '. Try dismissing overlays first.',
      coveringElement: {
        tag: top.tagName.toLowerCase(),
        id: top.id || undefined,
        className: (typeof top.className === 'string' && top.className) || undefined
      }
    };
  }

  return { actionable: false, reason: 'No element found at click point (' + x + ', ' + y + '). Try scrolling the element into view first.' };
}`;

/**
 * Editable check (for fill):
 * - NOT disabled (same logic as enabled check)
 * - NOT readonly (element.hasAttribute('readonly') or aria-readonly="true")
 * - Must be <input>, <textarea>, <select>, or [contenteditable]
 */
export const CHECK_EDITABLE = `function() {
  // Must be an editable element type
  var tag = this.tagName;
  var isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
    this.isContentEditable;
  if (!isEditable) {
    return { actionable: false, reason: 'Element is not an editable type (<' + tag.toLowerCase() + '>). Target an <input>, <textarea>, <select>, or [contenteditable] element instead.' };
  }

  // Check disabled
  var disableable = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'OPTGROUP'];
  if (disableable.indexOf(tag) !== -1 && this.disabled) {
    return { actionable: false, reason: 'Element is disabled. Check if a prerequisite field needs to be filled first.' };
  }

  // Check ancestor FIELDSET[disabled]
  var parent = this.parentElement;
  while (parent) {
    if (parent.tagName === 'FIELDSET' && parent.disabled) {
      var legend = parent.querySelector(':scope > legend');
      if (!legend || !legend.contains(this)) {
        return { actionable: false, reason: 'Element is inside a disabled fieldset. Check if a prerequisite field needs to be filled first.' };
      }
    }
    parent = parent.parentElement;
  }

  // aria-disabled walking up (crosses shadow DOM)
  var node = this;
  while (node) {
    if (node.nodeType === 1 && node.getAttribute && node.getAttribute('aria-disabled') === 'true') {
      return { actionable: false, reason: 'Element or ancestor has aria-disabled="true". Check if a prerequisite field needs to be filled first.' };
    }
    if (node.parentElement) {
      node = node.parentElement;
    } else if (node.getRootNode && node.getRootNode() !== node) {
      var root = node.getRootNode();
      node = root.host || null;
    } else {
      break;
    }
  }

  // Check readonly
  if (this.hasAttribute && this.hasAttribute('readonly')) {
    return { actionable: false, reason: 'Cannot fill a readonly input. Remove the readonly attribute or target a different element.' };
  }
  if (this.getAttribute && this.getAttribute('aria-readonly') === 'true') {
    return { actionable: false, reason: 'Cannot fill a readonly input (aria-readonly="true"). Remove the attribute or target a different element.' };
  }

  return { actionable: true };
}`;

// ============ Internal Helpers ============

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BACKOFF = [0, 20, 100, 100];

/**
 * Execute a single check against an element via Runtime.callFunctionOn
 */
async function runCheck(
  cdp: CDPClient,
  objectId: string,
  check: ActionabilityCheck,
  options?: ActionabilityOptions
): Promise<ActionabilityResult> {
  let script: string;
  let awaitPromise = false;
  const args: Array<{ value: unknown }> = [];

  switch (check) {
    case 'visible':
      script = CHECK_VISIBLE;
      break;
    case 'enabled':
      script = CHECK_ENABLED;
      break;
    case 'stable':
      script = CHECK_STABLE;
      awaitPromise = true;
      break;
    case 'hitTarget':
      script = CHECK_HIT_TARGET;
      if (options?.coordinates) {
        args.push({ value: options.coordinates.x });
        args.push({ value: options.coordinates.y });
      } else {
        args.push({ value: undefined });
        args.push({ value: undefined });
      }
      break;
    case 'editable':
      script = CHECK_EDITABLE;
      break;
    default: {
      const _exhaustive: never = check;
      throw new Error(`Unknown actionability check: ${_exhaustive}`);
    }
  }

  const params: Record<string, unknown> = {
    functionDeclaration: script,
    objectId,
    returnByValue: true,
    arguments: args,
  };

  if (awaitPromise) {
    params['awaitPromise'] = true;
  }

  const response = await cdp.send<{
    result: { value: ActionabilityResult };
    exceptionDetails?: { text: string };
  }>('Runtime.callFunctionOn', params);

  if (response.exceptionDetails) {
    return {
      actionable: false,
      reason: `Check "${check}" threw: ${response.exceptionDetails.text}`,
      failureType: check,
    };
  }

  const result = response.result.value;
  if (!result.actionable) {
    result.failureType = check;
  }
  return result;
}

/**
 * Run all checks sequentially, short-circuiting on first failure
 */
async function runChecks(
  cdp: CDPClient,
  objectId: string,
  checks: ActionabilityCheck[],
  options?: ActionabilityOptions
): Promise<ActionabilityResult> {
  for (const check of checks) {
    const result = await runCheck(cdp, objectId, check, options);
    if (!result.actionable) {
      return result;
    }
  }
  return { actionable: true };
}

// ============ Main Entry Point ============

/**
 * Ensure an element passes all actionability checks, retrying with progressive backoff.
 *
 * Throws a descriptive error if the element is not actionable within the timeout.
 *
 * @param cdp - CDP client instance
 * @param objectId - Remote object ID of the target element
 * @param checks - List of checks to run (short-circuits on first failure)
 * @param options - Timeout and coordinate options
 */
export async function ensureActionable(
  cdp: CDPClient,
  objectId: string,
  checks: ActionabilityCheck[],
  options?: ActionabilityOptions
): Promise<void> {
  const timeout = options?.timeout ?? 30000;
  const start = Date.now();
  let attempt = 0;
  let broughtToFront = false;

  while (true) {
    const result = await runChecks(cdp, objectId, checks, options);
    if (result.actionable) return;

    // A backgrounded/occluded tab is rAF-throttled by Chrome, so its layout can
    // report a zero-size rect indefinitely and this wait would otherwise poll to
    // the full timeout. On the FIRST zero-size result, foreground the tab once
    // (best-effort) and re-measure immediately rather than backing off. Foreground
    // resumes rendering, so a genuinely-laid-out element measures nonzero at once.
    if (
      !broughtToFront &&
      result.failureType === 'visible' &&
      result.reason?.includes('zero size')
    ) {
      broughtToFront = true;
      try {
        await cdp.send('Page.bringToFront');
      } catch {
        // Headless / environments that reject bringToFront: fall through to poll.
      }
      continue;
    }

    if (Date.now() - start >= timeout) {
      throw new ActionabilityError(
        `Element not actionable: ${result.reason}`,
        result.failureType,
        result.coveringElement
      );
    }

    const delay = attempt < BACKOFF.length ? (BACKOFF[attempt] ?? 0) : 500;
    if (delay > 0) await sleep(delay);
    attempt++;
  }
}
