/**
 * Snapshot diff algorithm for comparing page states
 */

import type { PageSnapshot, SnapshotNode } from './types.ts';

/** Comparable scalar fields of SnapshotNode */
type SnapshotNodeField = 'role' | 'name' | 'value' | 'disabled' | 'checked' | 'ref';

/**
 * Diff metadata
 */
export interface DiffMetadata {
  before: { url: string; timestamp: string; title: string };
  after: { url: string; timestamp: string; title: string };
  generatedAt: string;
}

/**
 * Change summary
 */
export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

/**
 * A changed element
 */
export interface ChangedElement {
  key: string;
  before: SnapshotNode;
  after: SnapshotNode;
  changedFields: SnapshotNodeField[];
}

/**
 * Snapshot diff result
 */
export interface SnapshotDiff {
  metadata: DiffMetadata;
  summary: DiffSummary;
  changes: {
    added: SnapshotNode[];
    removed: SnapshotNode[];
    changed: ChangedElement[];
  };
}

/**
 * Create a stable key for matching elements across snapshots
 * Key is based on role, name, and tree position
 */
function getElementKey(node: SnapshotNode, path: string[]): string {
  const name = node.name ?? '';
  return `${node.role}::${name}::${path.join('/')}`;
}

/**
 * Flatten a tree into a list with path information
 */
function flattenTree(
  nodes: SnapshotNode[],
  path: string[] = []
): Array<{ node: SnapshotNode; key: string; path: string[] }> {
  const result: Array<{ node: SnapshotNode; key: string; path: string[] }> = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const currentPath = [...path, String(i)];
    const key = getElementKey(node, currentPath);

    result.push({ node, key, path: currentPath });

    if (node.children) {
      result.push(...flattenTree(node.children, currentPath));
    }
  }

  return result;
}

/**
 * Compare two nodes and return changed fields
 */
function compareNodes(before: SnapshotNode, after: SnapshotNode): SnapshotNodeField[] {
  const changedFields: SnapshotNodeField[] = [];

  // Compare basic properties
  if (before.role !== after.role) {
    changedFields.push('role');
  }
  if (before.name !== after.name) {
    changedFields.push('name');
  }
  if (before.value !== after.value) {
    changedFields.push('value');
  }
  if (before.disabled !== after.disabled) {
    changedFields.push('disabled');
  }
  if (before.checked !== after.checked) {
    changedFields.push('checked');
  }

  return changedFields;
}

/**
 * Diff two snapshots and return the differences
 */
export function diffSnapshots(before: PageSnapshot, after: PageSnapshot): SnapshotDiff {
  // Flatten both trees
  const beforeFlat = flattenTree(before.accessibilityTree);
  const afterFlat = flattenTree(after.accessibilityTree);

  // Create maps for quick lookup
  const beforeMap = new Map(beforeFlat.map((item) => [item.key, item]));
  const afterMap = new Map(afterFlat.map((item) => [item.key, item]));

  const added: SnapshotNode[] = [];
  const removed: SnapshotNode[] = [];
  const changed: ChangedElement[] = [];
  let unchanged = 0;

  // Find added and changed elements
  for (const afterItem of afterFlat) {
    const beforeItem = beforeMap.get(afterItem.key);

    if (!beforeItem) {
      added.push(afterItem.node);
    } else {
      const changedFields = compareNodes(beforeItem.node, afterItem.node);
      if (changedFields.length > 0) {
        changed.push({
          key: afterItem.key,
          before: beforeItem.node,
          after: afterItem.node,
          changedFields,
        });
      } else {
        unchanged++;
      }
    }
  }

  // Find removed elements
  for (const beforeItem of beforeFlat) {
    if (!afterMap.has(beforeItem.key)) {
      removed.push(beforeItem.node);
    }
  }

  return {
    metadata: {
      before: {
        url: before.url,
        timestamp: before.timestamp,
        title: before.title,
      },
      after: {
        url: after.url,
        timestamp: after.timestamp,
        title: after.title,
      },
      generatedAt: new Date().toISOString(),
    },
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged,
    },
    changes: {
      added,
      removed,
      changed,
    },
  };
}

/**
 * Format diff in a human-readable format
 */
export function formatDiffPretty(diff: SnapshotDiff): string {
  const lines: string[] = [];

  lines.push(`Snapshot Diff: ${diff.metadata.after.url}`);
  lines.push(`  Before: ${diff.metadata.before.timestamp}`);
  lines.push(`  After:  ${diff.metadata.after.timestamp}`);
  lines.push('');

  if (diff.summary.added === 0 && diff.summary.removed === 0 && diff.summary.changed === 0) {
    lines.push('No changes detected.');
    return lines.join('\n');
  }

  lines.push('Changes:');

  // Added elements
  for (const node of diff.changes.added) {
    const name = node.name ? ` "${node.name}"` : '';
    lines.push(`  + [${node.ref}] ${node.role}${name} (new)`);
  }

  // Changed elements
  for (const item of diff.changes.changed) {
    const name = item.after.name ? ` "${item.after.name}"` : '';
    const fieldChanges = item.changedFields
      .map((field) => {
        const beforeVal = item.before[field];
        const afterVal = item.after[field];
        return `${field}: ${JSON.stringify(beforeVal)} → ${JSON.stringify(afterVal)}`;
      })
      .join(', ');
    lines.push(`  ~ [${item.after.ref}] ${item.after.role}${name} ${fieldChanges}`);
  }

  // Removed elements
  for (const node of diff.changes.removed) {
    const name = node.name ? ` "${node.name}"` : '';
    lines.push(`  - [${node.ref}] ${node.role}${name} (removed)`);
  }

  lines.push('');
  lines.push(
    `Summary: +${diff.summary.added} added, -${diff.summary.removed} removed, ~${diff.summary.changed} changed`
  );

  return lines.join('\n');
}
