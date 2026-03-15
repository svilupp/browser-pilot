/**
 * Delta extraction — compares page state before/after actions
 */

import type { FormField, PageSnapshot, SnapshotNode } from './types.ts';

export interface PageState {
  url: string;
  title: string;
  headings: string[];
  formFields: Array<{ label?: string; name?: string; id?: string; value: unknown; type: string }>;
  buttons: Array<{ text: string; disabled: boolean; ref?: string }>;
  alerts: string[];
  visibleText: string;
}

export interface DeltaChange {
  kind:
    | 'url'
    | 'title'
    | 'heading_added'
    | 'heading_removed'
    | 'field_changed'
    | 'button_changed'
    | 'alert_added'
    | 'alert_removed'
    | 'text_changed';
  before?: string;
  after?: string;
  detail?: string;
}

export interface DeltaResult {
  changes: DeltaChange[];
  before: PageState;
  after: PageState;
  hasChanges: boolean;
}

/**
 * Extract a lightweight page state from snapshot + forms data.
 * Used for delta comparison.
 */
export function extractPageState(
  url: string,
  title: string,
  snapshot: PageSnapshot,
  forms: FormField[],
  pageText: string
): PageState {
  const headings: string[] = [];
  const buttons: Array<{ text: string; disabled: boolean; ref?: string }> = [];
  const alerts: string[] = [];

  function walkNodes(nodes: SnapshotNode[]) {
    for (const node of nodes) {
      const role = node.role?.toLowerCase() ?? '';
      if (role === 'heading' && node.name) {
        headings.push(node.name);
      }
      if ((role === 'button' || role === 'link') && node.name) {
        const disabled = node.disabled ?? false;
        buttons.push({ text: node.name, disabled, ref: node.ref });
      }
      if (role === 'alert' && node.name) {
        alerts.push(node.name);
      }
      if (node.children) {
        walkNodes(node.children);
      }
    }
  }

  walkNodes(snapshot.accessibilityTree);

  const formFields = forms.map((f) => ({
    label: f.label,
    name: f.name,
    id: f.id,
    value: f.value,
    type: f.type,
  }));

  return {
    url,
    title,
    headings,
    formFields,
    buttons,
    alerts,
    visibleText: pageText.slice(0, 3000),
  };
}

/**
 * Compute delta between two page states
 */
export function computeDelta(before: PageState, after: PageState): DeltaResult {
  const changes: DeltaChange[] = [];

  if (before.url !== after.url) {
    changes.push({ kind: 'url', before: before.url, after: after.url });
  }
  if (before.title !== after.title) {
    changes.push({ kind: 'title', before: before.title, after: after.title });
  }

  // Headings
  const beforeHeadings = new Set(before.headings);
  const afterHeadings = new Set(after.headings);
  for (const h of after.headings) {
    if (!beforeHeadings.has(h)) {
      changes.push({ kind: 'heading_added', after: h });
    }
  }
  for (const h of before.headings) {
    if (!afterHeadings.has(h)) {
      changes.push({ kind: 'heading_removed', before: h });
    }
  }

  // Form fields
  const beforeFieldMap = new Map(
    before.formFields.map((f) => [f.id ?? f.name ?? f.label ?? '', f])
  );
  for (const af of after.formFields) {
    const key = af.id ?? af.name ?? af.label ?? '';
    const bf = beforeFieldMap.get(key);
    if (bf && JSON.stringify(bf.value) !== JSON.stringify(af.value)) {
      changes.push({
        kind: 'field_changed',
        before: String(bf.value ?? ''),
        after: String(af.value ?? ''),
        detail: af.label ?? af.name ?? af.id ?? key,
      });
    }
  }

  // Buttons
  const beforeBtnMap = new Map(before.buttons.map((b) => [b.text, b]));
  for (const ab of after.buttons) {
    const bb = beforeBtnMap.get(ab.text);
    if (bb && bb.disabled !== ab.disabled) {
      changes.push({
        kind: 'button_changed',
        detail: ab.text,
        before: bb.disabled ? 'disabled' : 'enabled',
        after: ab.disabled ? 'disabled' : 'enabled',
      });
    }
  }

  // Alerts
  const beforeAlerts = new Set(before.alerts);
  const afterAlerts = new Set(after.alerts);
  for (const a of after.alerts) {
    if (!beforeAlerts.has(a)) {
      changes.push({ kind: 'alert_added', after: a });
    }
  }
  for (const a of before.alerts) {
    if (!afterAlerts.has(a)) {
      changes.push({ kind: 'alert_removed', before: a });
    }
  }

  return {
    changes,
    before,
    after,
    hasChanges: changes.length > 0,
  };
}
