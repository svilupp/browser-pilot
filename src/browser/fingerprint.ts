/**
 * Semantic fingerprints for stable element identity across rerenders.
 *
 * A fingerprint captures the logical identity of an interactive element
 * (role, name, section context, stable attributes) so that a stale ref
 * can be recovered cheaply after a lightweight DOM rerender.
 */

import type { SnapshotNode } from './types.ts';

export interface SemanticFingerprint {
  /** Accessibility role */
  role: string;
  /** Accessible name */
  name: string;
  /** Control value shape (type, not actual value) */
  valueShape: string;
  /** Associated label text */
  label: string;
  /** Stable attributes (id, name, type) extracted from properties */
  stableAttrs: Record<string, string>;
  /** Nearest heading ancestor */
  nearestHeading: string;
  /** Position among same-role siblings */
  siblingIndex: number;
  /** Section path: heading trail from root */
  sectionPath: string[];
}

/**
 * Create a semantic fingerprint for a snapshot node.
 */
export function createFingerprint(
  node: SnapshotNode,
  context: {
    headingTrail: string[];
    siblingIndex: number;
    nearestHeading: string;
  }
): SemanticFingerprint {
  const role = node.role?.toLowerCase() ?? '';
  const name = node.name ?? '';

  // Value shape: just the type, not the actual value
  let valueShape = '';
  if (node.value !== undefined) {
    valueShape =
      typeof node.value === 'string'
        ? 'text'
        : typeof node.value === 'number'
          ? 'number'
          : typeof node.value === 'boolean'
            ? 'boolean'
            : 'other';
  }

  // Extract stable attributes from properties record (if populated)
  const stableAttrs: Record<string, string> = {};
  if (node.properties) {
    for (const key of ['id', 'name', 'type', 'aria-label'] as const) {
      const val = node.properties[key];
      if (val !== undefined && val !== null) {
        stableAttrs[key] = String(val);
      }
    }
  }

  return {
    role,
    name,
    valueShape,
    label: name, // label is typically the accessible name
    stableAttrs,
    nearestHeading: context.nearestHeading,
    siblingIndex: context.siblingIndex,
    sectionPath: [...context.headingTrail],
  };
}

/**
 * Compute a string key from a fingerprint for fast map-based matching.
 */
export function fingerprintKey(fp: SemanticFingerprint): string {
  const parts = [fp.role, fp.name, fp.sectionPath.join('>')];
  if (fp.stableAttrs['id']) parts.push(`id=${fp.stableAttrs['id']}`);
  if (fp.stableAttrs['name']) parts.push(`name=${fp.stableAttrs['name']}`);
  return parts.join('|');
}

/**
 * Score how similar two fingerprints are (0–1, higher = more similar).
 * Returns 0 immediately if the roles differ.
 */
export function fingerprintSimilarity(a: SemanticFingerprint, b: SemanticFingerprint): number {
  let score = 0;
  let weight = 0;

  // Role must match
  weight += 3;
  if (a.role === b.role) score += 3;
  else return 0; // Role mismatch = definitely different element

  // Name match (highest weight)
  weight += 5;
  if (a.name && b.name && a.name === b.name) score += 5;
  else if (a.name && b.name && a.name.toLowerCase() === b.name.toLowerCase()) score += 4;

  // Section path match
  weight += 3;
  const pathA = a.sectionPath.join('>');
  const pathB = b.sectionPath.join('>');
  if (pathA === pathB) score += 3;
  else if (pathA && pathB && (pathA.includes(pathB) || pathB.includes(pathA))) score += 1;

  // Stable attribute matches
  const attrKeys = new Set([...Object.keys(a.stableAttrs), ...Object.keys(b.stableAttrs)]);
  for (const key of attrKeys) {
    weight += 2;
    if (a.stableAttrs[key] && b.stableAttrs[key] && a.stableAttrs[key] === b.stableAttrs[key]) {
      score += 2;
    }
  }

  // Sibling position
  weight += 1;
  if (a.siblingIndex === b.siblingIndex) score += 1;

  return score / weight;
}

/** Roles considered interactive for fingerprinting purposes. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'tab',
  'switch',
  'searchbox',
  'spinbutton',
  'slider',
]);

/**
 * Build a fingerprint map for all interactive nodes in a snapshot tree.
 * Keys are the node refs (e.g. "e1").
 */
export function buildFingerprintMap(nodes: SnapshotNode[]): Map<string, SemanticFingerprint> {
  const map = new Map<string, SemanticFingerprint>();

  function walk(nodeList: SnapshotNode[], headingTrail: string[], nearestHeading: string) {
    const roleCounts = new Map<string, number>();

    for (const node of nodeList) {
      const role = node.role?.toLowerCase() ?? '';

      // Track heading trail
      let currentHeadingTrail = headingTrail;
      let currentNearestHeading = nearestHeading;
      if (role === 'heading' && node.name) {
        currentHeadingTrail = [...headingTrail, node.name];
        currentNearestHeading = node.name;
      }

      // Fingerprint interactive elements
      if (INTERACTIVE_ROLES.has(role) && node.ref) {
        const siblingCount = roleCounts.get(role) ?? 0;
        roleCounts.set(role, siblingCount + 1);

        const fp = createFingerprint(node, {
          headingTrail: currentHeadingTrail,
          siblingIndex: siblingCount,
          nearestHeading: currentNearestHeading,
        });
        map.set(node.ref, fp);
      }

      if (node.children) {
        walk(node.children, currentHeadingTrail, currentNearestHeading);
      }
    }
  }

  walk(nodes, [], '');
  return map;
}

/**
 * Attempt to recover a stale ref by matching its fingerprint against
 * the current snapshot's fingerprints.
 *
 * Returns the new ref and confidence score, or `null` when no
 * unambiguous match above the threshold exists.
 */
export function recoverStaleRef(
  staleFingerprint: SemanticFingerprint,
  currentFingerprints: Map<string, SemanticFingerprint>,
  threshold = 0.7,
  ambiguityMargin = 0.15
): { ref: string; confidence: number } | null {
  let bestRef: string | null = null;
  let bestScore = 0;
  let secondBestScore = 0;

  for (const [ref, fp] of currentFingerprints) {
    const similarity = fingerprintSimilarity(staleFingerprint, fp);
    if (similarity > bestScore) {
      secondBestScore = bestScore;
      bestScore = similarity;
      bestRef = ref;
    } else if (similarity > secondBestScore) {
      secondBestScore = similarity;
    }
  }

  if (!bestRef || bestScore < threshold) return null;

  // Ambiguity check: if second best is too close, don't guess
  if (secondBestScore > 0 && bestScore - secondBestScore < ambiguityMargin) return null;

  return { ref: bestRef, confidence: bestScore };
}
