/**
 * Overlay injection for visual ref labels
 *
 * Injects a visual overlay onto the page showing element refs
 * from the accessibility snapshot. Uses CDP to resolve elements
 * by backendNodeId rather than CSS selectors.
 */

import type { Page } from './page.ts';
import type { PageSnapshot } from './types.ts';

/**
 * Script to inject into the page for overlay infrastructure
 * Idempotent - can be called multiple times safely, will update labels on each call
 */
export const OVERLAY_SCRIPT = `(function() {
  // Check for existing DOM elements (handles cross-CLI reconnection)
  let style = document.getElementById('__bp-overlay-styles');
  let container = document.getElementById('__bp-overlay-container');

  // Clear existing labels before updating
  if (container) {
    container.innerHTML = '';
  }
  document.querySelectorAll('[data-bp-ref]').forEach(el => el.removeAttribute('data-bp-ref'));

  // Create infrastructure only if it doesn't exist
  if (!style) {
    style = document.createElement('style');
    style.id = '__bp-overlay-styles';
    style.textContent = \`
      [data-bp-ref] {
        outline: 2px dashed rgba(229, 57, 53, 0.6) !important;
        outline-offset: 2px !important;
      }
      .__bp-ref-label {
        position: absolute;
        background: #e53935;
        color: white;
        padding: 1px 4px;
        font-size: 10px;
        font-family: monospace;
        font-weight: bold;
        z-index: 10000;
        pointer-events: none;
        border-radius: 2px;
        line-height: 1.2;
      }
    \`;
    document.head.appendChild(style);
  }

  if (!container) {
    container = document.createElement('div');
    container.id = '__bp-overlay-container';
    container.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:10000;';
    document.body.appendChild(container);
  }

  // Always redefine to ensure correct container reference
  window.__bpAddLabel = function(ref, rect) {
    const label = document.createElement('div');
    label.className = '__bp-ref-label';
    label.textContent = ref;
    label.style.left = (rect.left + window.scrollX) + 'px';
    label.style.top = (rect.top + window.scrollY - 16) + 'px';
    container.appendChild(label);
  };

  window.__bpRemoveOverlay = function() {
    const c = document.getElementById('__bp-overlay-container');
    const s = document.getElementById('__bp-overlay-styles');
    if (c) c.remove();
    if (s) s.remove();
    document.querySelectorAll('[data-bp-ref]').forEach(el => el.removeAttribute('data-bp-ref'));
    delete window.__bpOverlayInstalled;
    delete window.__bpAddLabel;
    delete window.__bpRemoveOverlay;
  };

  window.__bpOverlayInstalled = true;
})();`;

/**
 * Script to remove the overlay
 */
const REMOVE_OVERLAY_SCRIPT = `(function() {
  if (window.__bpRemoveOverlay) {
    window.__bpRemoveOverlay();
  }
})();`;

/**
 * Add data-bp-ref attribute and create label for an element
 */
const ADD_REF_SCRIPT = `function(ref) {
  this.setAttribute('data-bp-ref', ref);
  const rect = this.getBoundingClientRect();
  if (window.__bpAddLabel) {
    window.__bpAddLabel(ref, {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height
    });
  }
  return true;
}`;

/**
 * Inject a visual overlay showing element refs on the page
 *
 * Uses CDP to resolve elements by backendNodeId from the snapshot's
 * ref map, which is more reliable than CSS selectors.
 *
 * @param page - The Page instance
 * @param snapshot - The page snapshot containing interactive elements
 */
export async function injectRefOverlay(page: Page, snapshot: PageSnapshot): Promise<void> {
  // First, inject the overlay infrastructure script
  await page.evaluate(OVERLAY_SCRIPT);

  // Get the ref map from the page (maps ref -> backendNodeId)
  const refMap = page.exportRefMap();
  const cdp = page.cdpClient;

  // Process each interactive element
  for (const element of snapshot.interactiveElements) {
    const backendNodeId = refMap[element.ref];
    if (backendNodeId === undefined) {
      continue;
    }

    try {
      // Resolve the backendNodeId to a RemoteObject
      const resolveResult = await cdp.send<{ object?: { objectId: string } }>('DOM.resolveNode', {
        backendNodeId,
      });

      if (!resolveResult.object?.objectId) {
        continue;
      }

      // Call function on the element to add data-bp-ref and create label
      await cdp.send('Runtime.callFunctionOn', {
        objectId: resolveResult.object.objectId,
        functionDeclaration: ADD_REF_SCRIPT,
        arguments: [{ value: element.ref }],
        returnByValue: true,
      });
    } catch {
      // Element may no longer exist - skip it
    }
  }
}

/**
 * Remove the ref overlay from the page
 *
 * @param page - The Page instance
 */
export async function removeRefOverlay(page: Page): Promise<void> {
  await page.evaluate(REMOVE_OVERLAY_SCRIPT);
}
