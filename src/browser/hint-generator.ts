/**
 * Failure hint generator for element not found errors
 */

import { fuzzyMatchElements } from './fuzzy-match.ts';
import type { Page } from './page.ts';
import type { FailureHint, InteractiveElement, PageSnapshot } from './types.ts';

/**
 * Action type to expected element roles mapping
 */
const ACTION_ROLE_MAP: Record<string, string[]> = {
  click: ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option'],
  fill: ['textbox', 'searchbox', 'textarea'],
  type: ['textbox', 'searchbox', 'textarea'],
  submit: ['button', 'form'],
  select: ['combobox', 'listbox', 'option'],
  check: ['checkbox', 'radio', 'switch'],
  uncheck: ['checkbox', 'switch'],
  focus: [], // Any focusable element
  hover: [], // Any element
  clear: ['textbox', 'searchbox', 'textarea'],
};

/**
 * Extract search intent from failed selectors
 */
function extractIntent(selectors: string[]): { text: string; patterns: string[] } {
  const patterns: string[] = [];
  let text = '';

  for (const selector of selectors) {
    // Skip ref selectors for intent extraction
    if (selector.startsWith('ref:')) {
      continue;
    }

    // Extract text from various selector patterns
    // #id-name -> id-name
    const idMatch = selector.match(/#([a-zA-Z0-9_-]+)/);
    if (idMatch) {
      patterns.push(idMatch[1]!);
    }

    // [aria-label="text"] -> text
    const ariaMatch = selector.match(/\[aria-label=["']([^"']+)["']\]/);
    if (ariaMatch) {
      patterns.push(ariaMatch[1]!);
    }

    // [data-testid="name"] -> name
    const testidMatch = selector.match(/\[data-testid=["']([^"']+)["']\]/);
    if (testidMatch) {
      patterns.push(testidMatch[1]!);
    }

    // .class-name -> class-name
    const classMatch = selector.match(/\.([a-zA-Z0-9_-]+)/);
    if (classMatch) {
      patterns.push(classMatch[1]!);
    }
  }

  // Combine patterns into a search text
  // Prioritize longer, more specific patterns
  patterns.sort((a, b) => b.length - a.length);
  text = patterns[0] ?? selectors[0] ?? '';

  return { text, patterns };
}

/**
 * Determine hint type from selector
 */
function getHintType(selector: string): 'ref' | 'testid' | 'aria' | 'id' | 'css' {
  if (selector.startsWith('ref:')) return 'ref';
  if (selector.includes('data-testid')) return 'testid';
  if (selector.includes('aria-label')) return 'aria';
  if (selector.startsWith('#')) return 'id';
  return 'css';
}

/**
 * Determine confidence level based on match score
 */
function getConfidence(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.8) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

/**
 * Generate diversified hints (different hint types)
 */
function diversifyHints(
  candidates: Array<{
    element: InteractiveElement;
    score: number;
    matchReason: string;
  }>,
  maxHints: number
): FailureHint[] {
  const hints: FailureHint[] = [];
  const usedTypes = new Set<string>();

  for (const candidate of candidates) {
    if (hints.length >= maxHints) break;

    // Generate the best selector for this candidate
    const refSelector = `ref:${candidate.element.ref}`;
    const hintType = getHintType(refSelector);

    // Try to use different selector types
    if (!usedTypes.has(hintType)) {
      hints.push({
        selector: refSelector,
        reason: candidate.matchReason,
        confidence: getConfidence(candidate.score),
        element: {
          ref: candidate.element.ref,
          role: candidate.element.role,
          name: candidate.element.name,
          disabled: candidate.element.disabled,
        },
      });
      usedTypes.add(hintType);
    } else if (hints.length < maxHints) {
      // Still add if we haven't hit max yet
      hints.push({
        selector: refSelector,
        reason: candidate.matchReason,
        confidence: getConfidence(candidate.score),
        element: {
          ref: candidate.element.ref,
          role: candidate.element.role,
          name: candidate.element.name,
          disabled: candidate.element.disabled,
        },
      });
    }
  }

  return hints;
}

/**
 * Generate failure hints for an element not found error
 */
export async function generateHints(
  page: Page,
  failedSelectors: string[],
  actionType: string,
  maxHints: number = 3
): Promise<FailureHint[]> {
  // Take a snapshot to get current page state
  let snapshot: PageSnapshot;
  try {
    snapshot = await page.snapshot();
  } catch {
    return []; // Can't generate hints if snapshot fails
  }

  // Extract search intent from failed selectors
  const intent = extractIntent(failedSelectors);

  // Filter candidates by action-appropriate roles
  const roleFilter = ACTION_ROLE_MAP[actionType] ?? [];
  let candidates = snapshot.interactiveElements;

  if (roleFilter.length > 0) {
    candidates = candidates.filter((el) => roleFilter.includes(el.role));
  }

  // Fuzzy match against candidates
  const matches = fuzzyMatchElements(intent.text, candidates, maxHints * 2);

  if (matches.length === 0) {
    return [];
  }

  // Diversify hints
  return diversifyHints(matches, maxHints);
}

/**
 * Generate hints from an existing snapshot (for use when snapshot is already available)
 */
export function generateHintsFromSnapshot(
  snapshot: PageSnapshot,
  failedSelectors: string[],
  actionType: string,
  maxHints: number = 3
): FailureHint[] {
  const intent = extractIntent(failedSelectors);

  const roleFilter = ACTION_ROLE_MAP[actionType] ?? [];
  let candidates = snapshot.interactiveElements;

  if (roleFilter.length > 0) {
    candidates = candidates.filter((el) => roleFilter.includes(el.role));
  }

  const matches = fuzzyMatchElements(intent.text, candidates, maxHints * 2);

  if (matches.length === 0) {
    return [];
  }

  return diversifyHints(matches, maxHints);
}
