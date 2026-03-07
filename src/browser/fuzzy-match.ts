/**
 * Fuzzy matching utilities for element search and hint generation
 */

import type { InteractiveElement } from './types.ts';

/**
 * Result of fuzzy matching an element
 */
export interface FuzzyMatch {
  element: InteractiveElement;
  score: number;
  matchReason: string;
}

/**
 * Jaro-Winkler similarity algorithm
 * Returns a value between 0 (no match) and 1 (exact match)
 */
export function jaroWinkler(a: string, b: string): number {
  // Handle edge cases
  if (a.length === 0 && b.length === 0) return 0.0;
  if (a.length === 0 || b.length === 0) return 0.0;
  if (a === b) return 1.0;

  // Convert to lowercase for case-insensitive matching
  const s1 = a.toLowerCase();
  const s2 = b.toLowerCase();

  // Calculate match window
  const matchWindow = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);

  const s1Matches: boolean[] = Array.from({ length: s1.length }, () => false);
  const s2Matches: boolean[] = Array.from({ length: s2.length }, () => false);

  let matches = 0;
  let transpositions = 0;

  // Find matching characters
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, s2.length);

    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  // Calculate Jaro similarity
  const jaro =
    (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3;

  // Calculate common prefix (up to 4 characters)
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(s1.length, s2.length)); i++) {
    if (s1[i] === s2[i]) {
      prefix++;
    } else {
      break;
    }
  }

  // Winkler modification: boost for common prefix
  const WINKLER_SCALING = 0.1;
  return jaro + prefix * WINKLER_SCALING * (1 - jaro);
}

/**
 * Combined string similarity score with contains bonus
 * Returns a value between 0 and 1
 */
export function stringSimilarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0.0;

  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();

  // Exact match
  if (lowerA === lowerB) return 1.0;

  const jw = jaroWinkler(a, b);

  // Bonus if one string contains the other
  let containsBonus = 0;
  if (lowerB.includes(lowerA)) {
    // Query is contained in target - good match
    containsBonus = 0.2;
  } else if (lowerA.includes(lowerB)) {
    // Target is contained in query - partial match
    containsBonus = 0.1;
  }

  return Math.min(1, jw + containsBonus);
}

/**
 * Score an element against a query string
 * Considers name, role, and selector parts with weighted scoring
 */
function scoreElement(query: string, element: InteractiveElement): number {
  const lowerQuery = query.toLowerCase();
  const words = lowerQuery.split(/\s+/).filter((w) => w.length > 0);

  // Name matching (highest weight: 0.6)
  let nameScore = 0;
  if (element.name) {
    const lowerName = element.name.toLowerCase();

    // Exact name match
    if (lowerName === lowerQuery) {
      nameScore = 1.0;
    }
    // Name contains query
    else if (lowerName.includes(lowerQuery)) {
      nameScore = 0.8;
    }
    // Word-level matching
    else if (words.length > 0) {
      const matchedWords = words.filter((w) => lowerName.includes(w));
      nameScore = (matchedWords.length / words.length) * 0.7;
    }
    // Fuzzy match
    else {
      nameScore = stringSimilarity(query, element.name) * 0.6;
    }
  }

  // Role matching (medium weight: 0.25)
  let roleScore = 0;
  const lowerRole = element.role.toLowerCase();
  if (lowerRole === lowerQuery || lowerQuery.includes(lowerRole)) {
    roleScore = 0.3;
  } else if (words.some((w) => lowerRole.includes(w))) {
    roleScore = 0.2;
  }

  // Selector parts matching (lower weight: 0.15)
  let selectorScore = 0;
  const lowerSelector = element.selector.toLowerCase();
  if (words.some((w) => lowerSelector.includes(w))) {
    selectorScore = 0.2;
  }

  // Combine scores with weights
  const totalScore = nameScore * 0.6 + roleScore * 0.25 + selectorScore * 0.15;

  return totalScore;
}

/**
 * Explain why an element matched a query
 */
function explainMatch(query: string, element: InteractiveElement, score: number): string {
  const reasons: string[] = [];
  const lowerQuery = query.toLowerCase();
  const words = lowerQuery.split(/\s+/).filter((w) => w.length > 0);

  // Check name match
  if (element.name) {
    const lowerName = element.name.toLowerCase();
    if (lowerName === lowerQuery) {
      reasons.push('exact name match');
    } else if (lowerName.includes(lowerQuery)) {
      reasons.push('name contains query');
    } else if (words.some((w) => lowerName.includes(w))) {
      const matchedWords = words.filter((w) => lowerName.includes(w));
      reasons.push(`name contains: ${matchedWords.join(', ')}`);
    } else if (stringSimilarity(query, element.name) > 0.5) {
      reasons.push('similar name');
    }
  }

  // Check role match
  const lowerRole = element.role.toLowerCase();
  if (lowerRole === lowerQuery || words.some((w) => w === lowerRole)) {
    reasons.push(`role: ${element.role}`);
  }

  // Check selector match
  if (words.some((w) => element.selector.toLowerCase().includes(w))) {
    reasons.push('selector match');
  }

  if (reasons.length === 0) {
    reasons.push(`fuzzy match (score: ${score.toFixed(2)})`);
  }

  return reasons.join(', ');
}

/**
 * Fuzzy match elements against a query string
 * Returns candidates sorted by score, filtered above threshold
 */
export function fuzzyMatchElements(
  query: string,
  elements: InteractiveElement[],
  maxResults: number = 5
): FuzzyMatch[] {
  if (!query || query.length === 0) {
    return [];
  }

  const THRESHOLD = 0.3;

  const scored = elements.map((element) => ({
    element,
    score: scoreElement(query, element),
  }));

  return scored
    .filter((s) => s.score >= THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => ({
      element: s.element,
      score: s.score,
      matchReason: explainMatch(query, s.element, s.score),
    }));
}
