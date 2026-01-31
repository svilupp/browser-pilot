/**
 * Selector generator for alternative selector suggestions
 */

import type { InteractiveElement, PageSnapshot } from './types.ts';

/**
 * Generated selector with its type
 */
export interface GeneratedSelector {
  selector: string;
  type: 'ref' | 'testid' | 'aria-label' | 'id' | 'role-name' | 'css';
}

/**
 * Escape special characters in attribute values for CSS selectors
 */
function escapeAttrValue(value: string): string {
  return value.replace(/"/g, '\\"').replace(/'/g, "\\'");
}

/**
 * Extract potential testid from selector string
 * Looks for data-testid, data-test-id, or data-test patterns
 */
function extractTestId(selector: string): string | null {
  const patterns = [
    /\[data-testid=["']([^"']+)["']\]/,
    /\[data-test-id=["']([^"']+)["']\]/,
    /\[data-test=["']([^"']+)["']\]/,
  ];

  for (const pattern of patterns) {
    const match = selector.match(pattern);
    if (match) {
      return match[1] ?? null;
    }
  }

  return null;
}

/**
 * Extract potential ID from selector string
 */
function extractId(selector: string): string | null {
  const match = selector.match(/#([a-zA-Z][a-zA-Z0-9_-]*)/);
  return match ? (match[1] ?? null) : null;
}

/**
 * Generate role-based selector
 */
function generateRoleSelector(element: InteractiveElement): string | null {
  if (!element.role || !element.name) {
    return null;
  }

  const escapedName = escapeAttrValue(element.name);
  return `[role="${element.role}"][aria-label="${escapedName}"]`;
}

/**
 * Generate CSS path from selector
 * Simplifies complex selectors to a cleaner form
 */
function simplifyCssPath(selector: string): string {
  // If it's already a simple selector, return as-is
  if (selector.startsWith('#') || selector.startsWith('.') || selector.startsWith('[')) {
    return selector;
  }

  // Remove descendant combinators and keep only the last part if it's specific enough
  const parts = selector.split(/\s+/);
  const lastPart = parts[parts.length - 1];

  if (lastPart && (lastPart.startsWith('#') || lastPart.includes('[') || lastPart.includes('.'))) {
    return lastPart;
  }

  // Return original if we can't simplify
  return selector;
}

/**
 * Generate alternative selectors for an element
 * Returns selectors in priority order: ref > testid > aria-label > id > role-name > css
 */
export function generateSelectors(
  element: InteractiveElement,
  _snapshot?: PageSnapshot
): GeneratedSelector[] {
  const selectors: GeneratedSelector[] = [];

  // 1. Ref selector (most reliable for browser-pilot)
  if (element.ref) {
    selectors.push({
      selector: `ref:${element.ref}`,
      type: 'ref',
    });
  }

  // 2. data-testid selector (if present in original selector)
  const testId = extractTestId(element.selector);
  if (testId) {
    selectors.push({
      selector: `[data-testid="${escapeAttrValue(testId)}"]`,
      type: 'testid',
    });
  }

  // 3. aria-label selector (if element has a name)
  if (element.name) {
    selectors.push({
      selector: `[aria-label="${escapeAttrValue(element.name)}"]`,
      type: 'aria-label',
    });
  }

  // 4. ID selector (if present in original selector)
  const id = extractId(element.selector);
  if (id) {
    selectors.push({
      selector: `#${id}`,
      type: 'id',
    });
  }

  // 5. Role + name selector (semantic)
  const roleSelector = generateRoleSelector(element);
  if (roleSelector) {
    selectors.push({
      selector: roleSelector,
      type: 'role-name',
    });
  }

  // 6. CSS path fallback (simplified from original selector)
  const cssPath = simplifyCssPath(element.selector);
  if (cssPath && !selectors.some((s) => s.selector === cssPath)) {
    selectors.push({
      selector: cssPath,
      type: 'css',
    });
  }

  return selectors;
}

/**
 * Get just the selector strings without type information
 */
export function generateSelectorStrings(
  element: InteractiveElement,
  snapshot?: PageSnapshot
): string[] {
  return generateSelectors(element, snapshot).map((s) => s.selector);
}
