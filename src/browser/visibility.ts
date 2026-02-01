/**
 * Enhanced visibility utilities for element diagnostics
 */

import type { CDPClient } from '../cdp/client.ts';
import { DEEP_QUERY_SCRIPT } from '../wait/strategies.ts';

/**
 * Detailed visibility state for an element
 */
export interface VisibilityState {
  /** Whether the element is considered visible */
  visible: boolean;
  /** CSS display property value */
  display: string;
  /** CSS visibility property value */
  visibility: string;
  /** CSS opacity value (0-1) */
  opacity: number;
  /** Element width in pixels */
  width: number;
  /** Element height in pixels */
  height: number;
  /** Whether the element is in the viewport */
  inViewport: boolean;
  /** Reasons why element is not visible (empty if visible) */
  reasons: string[];
}

/**
 * Information about an element covering another element
 */
export interface CoveringElement {
  /** Element ref if available */
  ref?: string;
  /** HTML tag name */
  tagName: string;
  /** Element id attribute */
  id?: string;
  /** Element class attribute */
  className?: string;
  /** Computed z-index */
  zIndex?: number;
}

/**
 * Script to get detailed visibility state of an element by selector
 */
const VISIBILITY_STATE_SCRIPT = `
function getVisibilityState(selector) {
  ${DEEP_QUERY_SCRIPT}
  const el = deepQuery(selector);
  if (!el) {
    return null;
  }

  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();

  const display = style.display;
  const visibility = style.visibility;
  const opacity = parseFloat(style.opacity);
  const width = rect.width;
  const height = rect.height;

  // Check if in viewport
  const inViewport = (
    rect.top < window.innerHeight &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.right > 0
  );

  // Collect reasons for invisibility
  const reasons = [];
  if (display === 'none') {
    reasons.push('display: none');
  }
  if (visibility === 'hidden') {
    reasons.push('visibility: hidden');
  }
  if (opacity === 0) {
    reasons.push('opacity: 0');
  }
  if (width === 0 && height === 0) {
    reasons.push('zero dimensions');
  } else if (width === 0) {
    reasons.push('zero width');
  } else if (height === 0) {
    reasons.push('zero height');
  }
  if (!inViewport && width > 0 && height > 0) {
    reasons.push('outside viewport');
  }

  const visible = reasons.length === 0;

  return {
    visible,
    display,
    visibility,
    opacity,
    width,
    height,
    inViewport,
    reasons
  };
}
`;

/**
 * Script to detect if an element is covered by another element
 */
const COVERING_ELEMENT_SCRIPT = `
function detectCoveringElement(selector) {
  ${DEEP_QUERY_SCRIPT}
  const el = deepQuery(selector);
  if (!el) {
    return { error: 'Element not found' };
  }

  const rect = el.getBoundingClientRect();

  // Check center point
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  // Get element at center point
  const topEl = document.elementFromPoint(centerX, centerY);

  if (!topEl) {
    return { covered: false };
  }

  // Check if the target element is the top element or contains it
  if (topEl === el || el.contains(topEl)) {
    return { covered: false };
  }

  // Element is covered - get info about covering element
  const style = getComputedStyle(topEl);
  return {
    covered: true,
    coveringElement: {
      tagName: topEl.tagName.toLowerCase(),
      id: topEl.id || undefined,
      className: topEl.className || undefined,
      zIndex: style.zIndex === 'auto' ? undefined : parseInt(style.zIndex, 10)
    }
  };
}
`;

/**
 * Script to get visibility state by nodeId
 */
const VISIBILITY_BY_NODE_SCRIPT = `
function getVisibilityStateByNode(nodeId) {
  // This script expects nodeId to be resolved to an element via CDP
  // It's called after Runtime.callFunctionOn with the target element
  const el = this;
  if (!el) {
    return null;
  }

  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();

  const display = style.display;
  const visibility = style.visibility;
  const opacity = parseFloat(style.opacity);
  const width = rect.width;
  const height = rect.height;

  const inViewport = (
    rect.top < window.innerHeight &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.right > 0
  );

  const reasons = [];
  if (display === 'none') reasons.push('display: none');
  if (visibility === 'hidden') reasons.push('visibility: hidden');
  if (opacity === 0) reasons.push('opacity: 0');
  if (width === 0 && height === 0) reasons.push('zero dimensions');
  else if (width === 0) reasons.push('zero width');
  else if (height === 0) reasons.push('zero height');
  if (!inViewport && width > 0 && height > 0) reasons.push('outside viewport');

  return {
    visible: reasons.length === 0,
    display,
    visibility,
    opacity,
    width,
    height,
    inViewport,
    reasons
  };
}
`;

/**
 * Script to detect covering element by node reference
 */
const COVERING_BY_NODE_SCRIPT = `
function detectCoveringByNode() {
  const el = this;
  if (!el) {
    return { error: 'Element not found' };
  }

  const rect = el.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  const topEl = document.elementFromPoint(centerX, centerY);

  if (!topEl) {
    return { covered: false };
  }

  if (topEl === el || el.contains(topEl)) {
    return { covered: false };
  }

  const style = getComputedStyle(topEl);
  return {
    covered: true,
    coveringElement: {
      tagName: topEl.tagName.toLowerCase(),
      id: topEl.id || undefined,
      className: topEl.className || undefined,
      zIndex: style.zIndex === 'auto' ? undefined : parseInt(style.zIndex, 10)
    }
  };
}
`;

/**
 * Get detailed visibility state for an element by selector
 */
export async function getVisibilityStateBySelector(
  cdp: CDPClient,
  selector: string,
  contextId?: number
): Promise<VisibilityState | null> {
  const params: Record<string, unknown> = {
    expression: `(${VISIBILITY_STATE_SCRIPT})(); getVisibilityState(${JSON.stringify(selector)})`,
    returnByValue: true,
  };

  if (contextId !== undefined) {
    params['contextId'] = contextId;
  }

  const result = await cdp.send<{ result: { value: VisibilityState | null } }>(
    'Runtime.evaluate',
    params
  );

  return result.result.value;
}

/**
 * Get detailed visibility state for an element by nodeId
 */
export async function getVisibilityState(
  cdp: CDPClient,
  nodeId: number
): Promise<VisibilityState | null> {
  // First, resolve the nodeId to a RemoteObject
  const resolveResult = await cdp.send<{ object?: { objectId: string } }>('DOM.resolveNode', {
    nodeId,
  });

  if (!resolveResult.object?.objectId) {
    return null;
  }

  const objectId = resolveResult.object.objectId;

  // Call function on the element
  const result = await cdp.send<{ result: { value: VisibilityState | null } }>(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: VISIBILITY_BY_NODE_SCRIPT,
      returnByValue: true,
    }
  );

  return result.result.value;
}

/**
 * Detect if an element is covered by another element (by selector)
 */
export async function detectCoveringElementBySelector(
  cdp: CDPClient,
  selector: string,
  contextId?: number
): Promise<CoveringElement | null> {
  const params: Record<string, unknown> = {
    expression: `(${COVERING_ELEMENT_SCRIPT})(); detectCoveringElement(${JSON.stringify(selector)})`,
    returnByValue: true,
  };

  if (contextId !== undefined) {
    params['contextId'] = contextId;
  }

  const result = await cdp.send<{
    result: { value: { covered: boolean; coveringElement?: CoveringElement; error?: string } };
  }>('Runtime.evaluate', params);

  const value = result.result.value;
  if (value.error || !value.covered) {
    return null;
  }

  return value.coveringElement ?? null;
}

/**
 * Detect if an element is covered by another element (by nodeId)
 */
export async function detectCoveringElement(
  cdp: CDPClient,
  nodeId: number
): Promise<CoveringElement | null> {
  // First, resolve the nodeId to a RemoteObject
  const resolveResult = await cdp.send<{ object?: { objectId: string } }>('DOM.resolveNode', {
    nodeId,
  });

  if (!resolveResult.object?.objectId) {
    return null;
  }

  const objectId = resolveResult.object.objectId;

  // Call function on the element
  const result = await cdp.send<{
    result: { value: { covered: boolean; coveringElement?: CoveringElement; error?: string } };
  }>('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: COVERING_BY_NODE_SCRIPT,
    returnByValue: true,
  });

  const value = result.result.value;
  if (value.error || !value.covered) {
    return null;
  }

  return value.coveringElement ?? null;
}
