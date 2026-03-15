/**
 * Review surface extraction — structured business state from current page
 */

import type { FormField, PageSnapshot, SnapshotNode } from './types.ts';

export interface KeyValuePair {
  key: string;
  value: string;
}

export interface SummaryCard {
  heading?: string;
  items: KeyValuePair[];
}

export interface TableData {
  headers: string[];
  rows: string[][];
}

export interface ReviewResult {
  url: string;
  title: string;
  headings: string[];
  forms: Array<{ label?: string; value: unknown; type: string; disabled: boolean }>;
  alerts: string[];
  summaryCards: SummaryCard[];
  tables: TableData[];
  keyValues: KeyValuePair[];
  statusLabels: string[];
}

/**
 * Extract review surface from page state
 */
export function extractReview(
  url: string,
  title: string,
  snapshot: PageSnapshot,
  forms: FormField[],
  pageText: string
): ReviewResult {
  const headings: string[] = [];
  const alerts: string[] = [];
  const statusLabels: string[] = [];
  const keyValues: KeyValuePair[] = [];
  const tables: TableData[] = [];
  const summaryCards: SummaryCard[] = [];

  function walkNodes(nodes: SnapshotNode[], parentHeading?: string) {
    let currentHeading = parentHeading;
    for (const node of nodes) {
      const role = node.role?.toLowerCase() ?? '';

      if (role === 'heading' && node.name) {
        headings.push(node.name);
        currentHeading = node.name;
      }
      if (role === 'alert' && node.name) {
        alerts.push(node.name);
      }
      if (role === 'status' && node.name) {
        statusLabels.push(node.name);
      }

      // Extract table data from grid/table roles
      if (role === 'table' || role === 'grid') {
        const table = extractTableFromNode(node);
        if (table) tables.push(table);
      }

      // Extract key-value pairs from definition lists / description roles
      if ((role === 'definition' || role === 'term') && node.name) {
        if (role === 'term') {
          keyValues.push({ key: node.name, value: '' });
        } else if (role === 'definition' && keyValues.length > 0) {
          const last = keyValues[keyValues.length - 1]!;
          if (!last.value) last.value = node.name;
        }
      }

      if (node.children) {
        walkNodes(node.children, currentHeading);
      }
    }
  }

  walkNodes(snapshot.accessibilityTree);

  // Extract key-value pairs from page text using common patterns
  const textKvPairs = extractKeyValueFromText(pageText);
  keyValues.push(...textKvPairs);

  const formEntries = forms.map((f) => ({
    label: f.label,
    value: f.value,
    type: f.type,
    disabled: f.disabled,
  }));

  return {
    url,
    title,
    headings,
    forms: formEntries,
    alerts,
    summaryCards,
    tables,
    keyValues,
    statusLabels,
  };
}

function extractTableFromNode(node: SnapshotNode): TableData | null {
  const headers: string[] = [];
  const rows: string[][] = [];

  function findRows(n: SnapshotNode) {
    const role = n.role?.toLowerCase() ?? '';
    if (role === 'columnheader' && n.name) {
      headers.push(n.name);
    }
    if (role === 'row') {
      const cells: string[] = [];
      if (n.children) {
        for (const child of n.children) {
          const childRole = child.role?.toLowerCase() ?? '';
          if ((childRole === 'cell' || childRole === 'gridcell') && child.name) {
            cells.push(child.name);
          }
        }
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (n.children) {
      for (const child of n.children) findRows(child);
    }
  }

  findRows(node);
  if (rows.length === 0) return null;
  return { headers, rows };
}

function extractKeyValueFromText(text: string): KeyValuePair[] {
  const pairs: KeyValuePair[] = [];
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    // Match "Key: Value" or "Key — Value" patterns
    const match = line.match(/^([A-Z][A-Za-z0-9 ]{1,30})[:—]\s+(.+)$/);
    if (match) {
      pairs.push({ key: match[1]!.trim(), value: match[2]!.trim() });
    }
  }

  return pairs.slice(0, 20); // Cap at 20 to keep bounded
}
