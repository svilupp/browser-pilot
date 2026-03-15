/**
 * Overlay-aware targeting — detect and prioritize visible overlays
 */

import type { Page } from './page.ts';

export interface OverlayInfo {
  /** Whether an overlay/modal is currently visible */
  hasOverlay: boolean;
  /** Selector of the detected overlay */
  overlaySelector?: string;
  /** Text content of the overlay (truncated) */
  overlayText?: string;
}

/**
 * Detect if a modal/overlay is currently covering the page.
 * Uses common overlay patterns: role="dialog", fixed/absolute positioning with backdrop.
 */
export async function detectOverlay(page: Page): Promise<OverlayInfo> {
  const result = await page.evaluate(`(() => {
    // Check for role="dialog" or role="alertdialog"
    const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]');
    for (const d of dialogs) {
      if (d.offsetParent !== null || getComputedStyle(d).display !== 'none') {
        return {
          hasOverlay: true,
          overlaySelector: d.id ? '#' + d.id : (d.getAttribute('role') ? '[role="' + d.getAttribute('role') + '"]' : 'dialog'),
          overlayText: (d.textContent || '').trim().slice(0, 200),
        };
      }
    }

    // Check for fixed/absolute positioned elements with high z-index that look like modals
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      const style = getComputedStyle(el);
      if (
        (style.position === 'fixed' || style.position === 'absolute') &&
        parseInt(style.zIndex || '0', 10) > 999 &&
        el.offsetWidth > 100 &&
        el.offsetHeight > 100 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      ) {
        const text = (el.textContent || '').trim();
        if (text.length > 10) {
          return {
            hasOverlay: true,
            overlaySelector: el.id ? '#' + el.id : null,
            overlayText: text.slice(0, 200),
          };
        }
      }
    }

    return { hasOverlay: false };
  })()`);

  return (result as OverlayInfo) ?? { hasOverlay: false };
}
