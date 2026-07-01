/**
 * Pure structural page signatures.
 *
 * A structure signature is a hash over the ROLE-TREE SKELETON of the
 * accessibility tree: for every node we emit a token derived from its
 * `depth + role` (and, optionally, its `disabled`/`checked` state bits).
 * We never include `name`, `value`, or any text content, so the signature
 * is invariant to content changes but sensitive to structural/layout
 * changes (added/removed/reordered nodes, changed nesting depth).
 *
 * This module is browser-free and pure: it only touches a supplied
 * {@link PageSnapshot} (or fetches one from a {@link Page}) and imports
 * nothing outside repo source. The local FNV-1a hash keeps it self
 * contained and keeps the output stable for downstream consumers
 * (e.g. Flightplan `match.sig`).
 */

import type { Page } from './page.ts';
import type { PageSnapshot, SnapshotNode } from './types.ts';

/**
 * Dynamic accessibility roles whose subtrees are collapsed out of the
 * structural signature by default. These are live-region / ephemeral
 * roles whose churn should not register as a structural change.
 */
export const DEFAULT_MASK_ROLES = [
  'status',
  'alert',
  'log',
  'timer',
  'progressbar',
  'marquee',
] as const;

export interface StructureSignatureOptions {
  /** Dynamic roles to mask out (default {@link DEFAULT_MASK_ROLES}). */
  maskRoles?: string[];
  /**
   * Optional structural matchers used to prune nodes (and their subtrees).
   * Since accessibility nodes carry no CSS selector, each entry is matched
   * exactly against a node's `role`, `name`, `ref`, or `role/name`.
   */
  maskSelectors?: string[];
  /** Optional cap on tree depth (root nodes are depth 0). */
  depth?: number;
  /** Include `disabled`/`checked` state bits in the signature; default false. */
  includeState?: boolean;
}

/**
 * Capture a pure structural signature over the accessibility tree.
 *
 * Accepts either a {@link PageSnapshot} (its accessibility tree is used
 * directly, returning synchronously) or a {@link Page} (a snapshot is
 * fetched first, returning a promise).
 *
 * @returns `"${urlPath}|${hash}"` where `urlPath` is the URL pathname with
 *   query + fragment stripped.
 */
export function captureStructureSignature(
  snapshot: PageSnapshot,
  opts?: StructureSignatureOptions
): string;
export function captureStructureSignature(
  page: Page,
  opts?: StructureSignatureOptions
): Promise<string>;
export function captureStructureSignature(
  snapshotOrPage: PageSnapshot | Page,
  opts: StructureSignatureOptions = {}
): string | Promise<string> {
  if (isPage(snapshotOrPage)) {
    return snapshotOrPage.snapshot().then((snap) => computeSignature(snap, opts));
  }
  return computeSignature(snapshotOrPage, opts);
}

/** Detect a {@link Page} by its `snapshot` method (a snapshot has no such method). */
function isPage(value: PageSnapshot | Page): value is Page {
  return typeof (value as Page).snapshot === 'function';
}

function computeSignature(snapshot: PageSnapshot, opts: StructureSignatureOptions): string {
  const maskRoles = new Set(
    (opts.maskRoles ?? DEFAULT_MASK_ROLES).map((role) => role.trim().toLowerCase())
  );
  const maskSelectors = new Set(opts.maskSelectors ?? []);
  const maxDepth = opts.depth;
  const includeState = opts.includeState ?? false;

  const tokens: string[] = [];

  const walk = (nodes: SnapshotNode[] | undefined, depth: number): void => {
    if (!nodes) return;
    if (maxDepth !== undefined && depth > maxDepth) return;
    for (const node of nodes) {
      const role = (node.role ?? '').toLowerCase();
      // Collapse masked live-region roles and their subtrees.
      if (maskRoles.has(role)) continue;
      if (isMaskedBySelector(node, role, maskSelectors)) continue;

      let token = `${depth}|${role}`;
      if (includeState) {
        token += `|${node.disabled ? 1 : 0}${node.checked ? 1 : 0}`;
      }
      tokens.push(token);

      walk(node.children, depth + 1);
    }
  };

  walk(snapshot.accessibilityTree, 0);

  return `${urlPathOf(snapshot.url)}|${fnv1a(tokens.join('\n'))}`;
}

/** True when any mask selector matches this node's role, name, ref, or role/name. */
function isMaskedBySelector(node: SnapshotNode, role: string, maskSelectors: Set<string>): boolean {
  if (maskSelectors.size === 0) return false;
  const name = node.name ?? '';
  return (
    maskSelectors.has(role) ||
    maskSelectors.has(name) ||
    maskSelectors.has(node.ref) ||
    maskSelectors.has(`${role}/${name}`)
  );
}

/** Extract the URL pathname, stripping query + fragment. */
function urlPathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    const noFragment = url.split('#')[0] ?? url;
    return noFragment.split('?')[0] ?? noFragment;
  }
}

/** Pure FNV-1a 32-bit hash over a token string, encoded in base36. */
function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
