/**
 * Element diagnostics for debugging selector issues
 */

import { fuzzyMatchElements } from './fuzzy-match.ts';
import type { Page } from './page.ts';
import { generateSelectorStrings } from './selector-generator.ts';
import type { InteractiveElement } from './types.ts';
import {
  type CoveringElement,
  detectCoveringElement,
  getVisibilityState,
  type VisibilityState,
} from './visibility.ts';

/**
 * Result for an exact match diagnosis
 */
export interface DiagnoseExactResult {
  matched: true;
  selector: string;
  ref: string;
  element: {
    role: string;
    name: string;
    nodeId: number;
    backendNodeId: number;
  };
  visibility: VisibilityState;
  interactivity: {
    disabled: boolean;
    readonly: boolean;
    covered: boolean;
    coveringElement?: CoveringElement;
    clickable: boolean;
    reason?: string;
  };
  attributes: Record<string, string>;
  suggestedSelectors: string[];
}

/**
 * Result for a fuzzy match diagnosis (no exact match found)
 */
export interface DiagnoseFuzzyResult {
  matched: false;
  query: string;
  candidates: Array<{
    score: number;
    ref: string;
    selector: string;
    role: string;
    name: string;
    visible: boolean;
    disabled: boolean;
    matchReason: string;
  }>;
}

export type DiagnoseResult = DiagnoseExactResult | DiagnoseFuzzyResult;

export interface DiagnoseOptions {
  /** Maximum candidates for fuzzy match (default: 5) */
  maxCandidates?: number;
  /** Include hidden elements in fuzzy results */
  includeHidden?: boolean;
}

/**
 * Check if a selector is a fuzzy query (doesn't look like a CSS/ref selector)
 */
function isFuzzyQuery(selector: string): boolean {
  // ref: prefix is exact
  if (selector.startsWith('ref:')) return false;

  // CSS selectors typically start with # . [ or contain specific patterns
  if (/^[#.[]/.test(selector)) return false;
  if (/\[.*\]/.test(selector)) return false;

  // Contains whitespace and no CSS combinator patterns - likely fuzzy
  if (/\s/.test(selector) && !/\s*[>+~]\s*/.test(selector)) return true;

  // Short single word without CSS chars is probably fuzzy
  if (!/[#.[\]>+~:=]/.test(selector)) return true;

  return false;
}

/**
 * Try to find an element using exact match first
 */
async function tryExactMatch(
  page: Page,
  selector: string
): Promise<{
  found: boolean;
  nodeId?: number;
  backendNodeId?: number;
  selectorUsed?: string;
}> {
  const cdp = page.cdpClient;

  // Handle ref: selector
  if (selector.startsWith('ref:')) {
    const ref = selector.slice(4);
    const refMap = page.exportRefMap();
    const backendNodeId = refMap[ref];

    if (!backendNodeId) {
      return { found: false };
    }

    try {
      // Ensure DOM is ready
      await cdp.send('DOM.getDocument');

      const pushResult = await cdp.send<{ nodeIds: number[] }>(
        'DOM.pushNodesByBackendIdsToFrontend',
        {
          backendNodeIds: [backendNodeId],
        }
      );

      if (pushResult.nodeIds?.[0]) {
        return {
          found: true,
          nodeId: pushResult.nodeIds[0],
          backendNodeId,
          selectorUsed: selector,
        };
      }
    } catch {
      return { found: false };
    }
  }

  // Standard CSS selector
  try {
    // Ensure DOM is ready
    const doc = await cdp.send<{ root: { nodeId: number } }>('DOM.getDocument');
    const rootNodeId = doc.root.nodeId;

    const result = await cdp.send<{ nodeId: number }>('DOM.querySelector', {
      nodeId: rootNodeId,
      selector,
    });

    if (result.nodeId && result.nodeId !== 0) {
      const describe = await cdp.send<{ node: { backendNodeId: number } }>('DOM.describeNode', {
        nodeId: result.nodeId,
      });

      return {
        found: true,
        nodeId: result.nodeId,
        backendNodeId: describe.node.backendNodeId,
        selectorUsed: selector,
      };
    }
  } catch {
    // Selector might be invalid
  }

  return { found: false };
}

/**
 * Get element attributes from DOM
 */
async function getElementAttributes(page: Page, nodeId: number): Promise<Record<string, string>> {
  const cdp = page.cdpClient;
  const attributes: Record<string, string> = {};

  try {
    const result = await cdp.send<{ attributes: string[] }>('DOM.getAttributes', {
      nodeId,
    });

    // Attributes come as [name, value, name, value, ...]
    for (let i = 0; i < result.attributes.length; i += 2) {
      const name = result.attributes[i];
      const value = result.attributes[i + 1];
      if (name && value !== undefined) {
        attributes[name] = value;
      }
    }
  } catch {
    // Node might not support attributes
  }

  return attributes;
}

/**
 * Diagnose an element by selector
 * Returns either exact match diagnostics or fuzzy match candidates
 */
export async function diagnoseElement(
  page: Page,
  selector: string,
  options: DiagnoseOptions = {}
): Promise<DiagnoseResult> {
  const { maxCandidates = 5, includeHidden = false } = options;
  const cdp = page.cdpClient;

  // First, take a snapshot for fuzzy matching and element info
  const snapshot = await page.snapshot();

  // Determine if this is a fuzzy query
  const fuzzy = isFuzzyQuery(selector);

  if (!fuzzy) {
    // Try exact match first
    const match = await tryExactMatch(page, selector);

    if (match.found && match.nodeId && match.backendNodeId) {
      // Get detailed diagnostics
      const visibility = (await getVisibilityState(cdp, match.nodeId)) ?? {
        visible: false,
        display: 'unknown',
        visibility: 'unknown',
        opacity: 1,
        width: 0,
        height: 0,
        inViewport: false,
        reasons: ['Could not determine visibility'],
      };

      const covering = await detectCoveringElement(cdp, match.nodeId);
      const attributes = await getElementAttributes(page, match.nodeId);

      // Find element info from snapshot
      const refMap = page.exportRefMap();
      let ref = '';
      for (const [r, bid] of Object.entries(refMap)) {
        if (bid === match.backendNodeId) {
          ref = r;
          break;
        }
      }

      // Find in interactive elements
      const interactiveEl = snapshot.interactiveElements.find((el) => el.ref === ref);

      // Determine clickability
      const disabled = attributes['disabled'] !== undefined || interactiveEl?.disabled === true;
      const readonly = attributes['readonly'] !== undefined;
      const covered = covering !== null;

      const clickable = visibility.visible && !disabled && !covered;
      let reason: string | undefined;

      if (!clickable) {
        const reasons: string[] = [];
        if (!visibility.visible) reasons.push('not visible');
        if (disabled) reasons.push('disabled');
        if (covered) reasons.push('covered by another element');
        reason = reasons.join(', ');
      }

      // Generate suggested selectors
      const element: InteractiveElement = interactiveEl ?? {
        ref,
        role: 'generic',
        name: '',
        selector: match.selectorUsed ?? selector,
        disabled,
      };

      const suggestedSelectors = generateSelectorStrings(element, snapshot);

      return {
        matched: true,
        selector: match.selectorUsed ?? selector,
        ref,
        element: {
          role: element.role,
          name: element.name,
          nodeId: match.nodeId,
          backendNodeId: match.backendNodeId,
        },
        visibility,
        interactivity: {
          disabled,
          readonly,
          covered,
          coveringElement: covering ?? undefined,
          clickable,
          reason,
        },
        attributes,
        suggestedSelectors,
      };
    }
  }

  // No exact match or fuzzy query - do fuzzy matching
  let candidates = snapshot.interactiveElements;

  // Filter hidden if requested
  if (!includeHidden) {
    // We can't easily check visibility without resolving each element
    // So we just include all for now and rely on the disabled flag
    candidates = candidates.filter((el) => !el.disabled);
  }

  const matches = fuzzyMatchElements(selector, candidates, maxCandidates);

  return {
    matched: false,
    query: selector,
    candidates: matches.map((m) => ({
      score: m.score,
      ref: m.element.ref,
      selector: m.element.selector,
      role: m.element.role,
      name: m.element.name,
      visible: true, // We assume visible since they're interactive
      disabled: m.element.disabled ?? false,
      matchReason: m.matchReason,
    })),
  };
}
