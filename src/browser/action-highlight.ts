/**
 * Action highlight overlays for recording screenshots
 *
 * Injects temporary visual indicators showing what action just occurred:
 * click crosshairs, fill outlines, navigation badges, etc.
 */

import type { ActionType, StepResult } from '../actions/types.ts';
import type { Page } from './page.ts';

export type HighlightKind =
  | 'click'
  | 'fill'
  | 'type'
  | 'select'
  | 'hover'
  | 'scroll'
  | 'navigate'
  | 'submit'
  | 'assert-pass'
  | 'assert-fail'
  | 'evaluate'
  | 'focus';

export interface HighlightOptions {
  kind: HighlightKind;
  /** Element bounding box (viewport coords) — null for page-level actions */
  bbox?: { x: number; y: number; width: number; height: number };
  /** Click/action point (viewport coords) */
  point?: { x: number; y: number };
  /** Label text (filled value, selected option, URL, etc.) */
  label?: string;
}

const HIGHLIGHT_STYLES: Record<HighlightKind, { outline: string; badge: string; marker?: string }> =
  {
    click: { outline: '3px solid rgba(229,57,53,0.8)', badge: '#e53935', marker: 'crosshair' },
    fill: { outline: '3px solid rgba(33,150,243,0.8)', badge: '#2196f3' },
    type: { outline: '3px solid rgba(33,150,243,0.6)', badge: '#2196f3' },
    select: { outline: '3px solid rgba(156,39,176,0.8)', badge: '#9c27b0' },
    hover: { outline: '2px dashed rgba(158,158,158,0.5)', badge: '#9e9e9e' },
    scroll: { outline: 'none', badge: '#607d8b', marker: 'arrow' },
    navigate: { outline: 'none', badge: '#4caf50' },
    submit: { outline: '3px solid rgba(255,152,0,0.8)', badge: '#ff9800' },
    'assert-pass': { outline: '3px solid rgba(76,175,80,0.8)', badge: '#4caf50', marker: 'check' },
    'assert-fail': { outline: '3px solid rgba(244,67,54,0.8)', badge: '#f44336', marker: 'cross' },
    evaluate: { outline: 'none', badge: '#ffc107' },
    focus: { outline: '3px dotted rgba(33,150,243,0.6)', badge: '#2196f3' },
  };

/** Build the JS to inject into the page */
function buildHighlightScript(options: HighlightOptions): string {
  const style = HIGHLIGHT_STYLES[options.kind];
  const label = options.label ? options.label.slice(0, 80) : undefined;
  // Escape for safe injection into JS string
  const escapedLabel = label
    ? label.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')
    : '';

  return `(function() {
    // Remove any existing highlight
    var existing = document.getElementById('__bp-action-highlight');
    if (existing) existing.remove();

    var container = document.createElement('div');
    container.id = '__bp-action-highlight';
    container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999;';

    ${
      options.bbox
        ? `
    // Element outline
    var outline = document.createElement('div');
    outline.style.cssText = 'position:fixed;' +
      'left:${options.bbox.x}px;top:${options.bbox.y}px;' +
      'width:${options.bbox.width}px;height:${options.bbox.height}px;' +
      '${style.outline !== 'none' ? `outline:${style.outline};outline-offset:-1px;` : ''}' +
      'pointer-events:none;box-sizing:border-box;';
    container.appendChild(outline);
    `
        : ''
    }

    ${
      options.point && style.marker === 'crosshair'
        ? `
    // Crosshair at click point
    var hLine = document.createElement('div');
    hLine.style.cssText = 'position:fixed;left:${options.point.x - 12}px;top:${options.point.y}px;' +
      'width:24px;height:2px;background:${style.badge};pointer-events:none;';
    var vLine = document.createElement('div');
    vLine.style.cssText = 'position:fixed;left:${options.point.x}px;top:${options.point.y - 12}px;' +
      'width:2px;height:24px;background:${style.badge};pointer-events:none;';
    // Dot at center
    var dot = document.createElement('div');
    dot.style.cssText = 'position:fixed;left:${options.point.x - 4}px;top:${options.point.y - 4}px;' +
      'width:8px;height:8px;border-radius:50%;background:${style.badge};pointer-events:none;';
    container.appendChild(hLine);
    container.appendChild(vLine);
    container.appendChild(dot);
    `
        : ''
    }

    ${
      label
        ? `
    // Badge with label
    var badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;' +
      ${
        options.bbox
          ? `'left:${options.bbox.x}px;top:${Math.max(0, options.bbox.y - 28)}px;'`
          : options.kind === 'navigate'
            ? "'left:50%;top:8px;transform:translateX(-50%);'"
            : "'right:8px;top:8px;'"
      } +
      'background:${style.badge};color:white;padding:4px 8px;' +
      'font-family:monospace;font-size:12px;font-weight:bold;' +
      'border-radius:3px;white-space:nowrap;max-width:400px;overflow:hidden;text-overflow:ellipsis;' +
      'pointer-events:none;';
    badge.textContent = '${escapedLabel}';
    container.appendChild(badge);
    `
        : ''
    }

    ${
      style.marker === 'check' && options.bbox
        ? `
    // Checkmark
    var check = document.createElement('div');
    check.style.cssText = 'position:fixed;left:${options.bbox.x + options.bbox.width / 2 - 10}px;' +
      'top:${options.bbox.y + options.bbox.height / 2 - 10}px;' +
      'width:20px;height:20px;font-size:18px;color:${style.badge};pointer-events:none;text-align:center;line-height:20px;';
    check.textContent = '\\u2713';
    container.appendChild(check);
    `
        : ''
    }

    ${
      style.marker === 'cross' && options.bbox
        ? `
    // Cross mark
    var cross = document.createElement('div');
    cross.style.cssText = 'position:fixed;left:${options.bbox.x + options.bbox.width / 2 - 10}px;' +
      'top:${options.bbox.y + options.bbox.height / 2 - 10}px;' +
      'width:20px;height:20px;font-size:18px;color:${style.badge};pointer-events:none;text-align:center;line-height:20px;font-weight:bold;';
    cross.textContent = '\\u2717';
    container.appendChild(cross);
    `
        : ''
    }

    document.body.appendChild(container);
    window.__bpRemoveActionHighlight = function() {
      var el = document.getElementById('__bp-action-highlight');
      if (el) el.remove();
      delete window.__bpRemoveActionHighlight;
    };
  })();`;
}

/** Inject a visual highlight for the action that just occurred */
export async function injectActionHighlight(page: Page, options: HighlightOptions): Promise<void> {
  try {
    await page.evaluate(buildHighlightScript(options));
  } catch {
    // Page might have navigated — highlight injection is best-effort
  }
}

/** Remove the action highlight */
export async function removeActionHighlight(page: Page): Promise<void> {
  try {
    await page.evaluate(`(function() {
      if (window.__bpRemoveActionHighlight) {
        window.__bpRemoveActionHighlight();
      }
    })()`);
  } catch {
    // Best-effort removal
  }
}

/** Map a StepResult to the appropriate HighlightKind */
export function stepToHighlightKind(step: StepResult): HighlightKind | null {
  switch (step.action) {
    case 'click':
      return 'click';
    case 'fill':
      return 'fill';
    case 'type':
      return 'type';
    case 'select':
      return 'select';
    case 'hover':
      return 'hover';
    case 'scroll':
      return 'scroll';
    case 'goto':
      return 'navigate';
    case 'submit':
      return 'submit';
    case 'focus':
      return 'focus';
    case 'evaluate':
    case 'press':
    case 'shortcut':
      return 'evaluate';
    case 'assertVisible':
    case 'assertExists':
    case 'assertText':
    case 'assertUrl':
    case 'assertValue':
      return step.success ? 'assert-pass' : 'assert-fail';
    // Observation-only actions — no highlight
    case 'wait':
    case 'snapshot':
    case 'forms':
    case 'text':
    case 'screenshot':
    case 'newTab':
    case 'closeTab':
    case 'switchFrame':
    case 'switchToMain':
      return null;
    default:
      return null;
  }
}

/** Get the label text for a highlight badge */
export function getHighlightLabel(
  step: {
    action: ActionType;
    value?: string | string[];
    url?: string;
    key?: string;
    combo?: string;
  },
  result: StepResult
): string | undefined {
  switch (step.action) {
    case 'fill':
    case 'type':
      return typeof step.value === 'string' ? `"${step.value}"` : undefined;
    case 'select':
      return typeof step.value === 'string' ? step.value : undefined;
    case 'goto':
      return step.url;
    case 'evaluate':
      return 'JS';
    case 'press':
      return step.key;
    case 'shortcut':
      return step.combo;
    case 'assertText':
    case 'assertUrl':
    case 'assertValue':
    case 'assertVisible':
    case 'assertExists':
      return result.success ? '\u2713' : '\u2717';
    default:
      return undefined;
  }
}
