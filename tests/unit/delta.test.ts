import { describe, expect, test } from 'bun:test';
import { computeDelta, extractPageState, type PageState } from '../../src/browser/delta.ts';
import type { FormField, PageSnapshot, SnapshotNode } from '../../src/browser/types.ts';

function makeSnapshot(nodes: SnapshotNode[]): PageSnapshot {
  return {
    url: 'https://example.com',
    title: 'Test',
    timestamp: new Date().toISOString(),
    accessibilityTree: nodes,
    interactiveElements: [],
    text: '',
  };
}

function makeFormField(overrides: Partial<FormField> = {}): FormField {
  return {
    tag: 'input',
    type: 'text',
    required: false,
    disabled: false,
    ...overrides,
  };
}

describe('extractPageState', () => {
  test('extracts headings from snapshot nodes', () => {
    const snapshot = makeSnapshot([
      { role: 'heading', name: 'Welcome', ref: 'e1' },
      { role: 'heading', name: 'About', ref: 'e2' },
      { role: 'generic', name: 'paragraph', ref: 'e3' },
    ]);

    const state = extractPageState('https://example.com', 'Test Page', snapshot, [], 'some text');

    expect(state.headings).toEqual(['Welcome', 'About']);
    expect(state.url).toBe('https://example.com');
    expect(state.title).toBe('Test Page');
  });

  test('extracts buttons from snapshot nodes', () => {
    const snapshot = makeSnapshot([
      { role: 'button', name: 'Submit', ref: 'e1' },
      { role: 'button', name: 'Cancel', ref: 'e2', disabled: true },
      { role: 'link', name: 'Learn More', ref: 'e3' },
    ]);

    const state = extractPageState('https://example.com', 'Test', snapshot, [], '');

    expect(state.buttons).toEqual([
      { text: 'Submit', disabled: false, ref: 'e1' },
      { text: 'Cancel', disabled: true, ref: 'e2' },
      { text: 'Learn More', disabled: false, ref: 'e3' },
    ]);
  });

  test('extracts alerts from snapshot nodes', () => {
    const snapshot = makeSnapshot([{ role: 'alert', name: 'Form saved successfully', ref: 'e1' }]);

    const state = extractPageState('https://example.com', 'Test', snapshot, [], '');

    expect(state.alerts).toEqual(['Form saved successfully']);
  });

  test('extracts form fields', () => {
    const forms: FormField[] = [
      makeFormField({ id: 'email', label: 'Email', value: 'test@example.com', type: 'email' }),
      makeFormField({ name: 'password', label: 'Password', value: '', type: 'password' }),
    ];

    const state = extractPageState('https://example.com', 'Test', makeSnapshot([]), forms, '');

    expect(state.formFields).toHaveLength(2);
    expect(state.formFields[0]).toEqual({
      label: 'Email',
      name: undefined,
      id: 'email',
      value: 'test@example.com',
      type: 'email',
    });
  });

  test('truncates visible text to 3000 chars', () => {
    const longText = 'x'.repeat(5000);
    const state = extractPageState('https://example.com', 'Test', makeSnapshot([]), [], longText);

    expect(state.visibleText.length).toBe(3000);
  });

  test('walks nested children', () => {
    const snapshot = makeSnapshot([
      {
        role: 'generic',
        ref: 'e1',
        children: [
          { role: 'heading', name: 'Nested Heading', ref: 'e2' },
          {
            role: 'generic',
            ref: 'e3',
            children: [{ role: 'button', name: 'Deep Button', ref: 'e4' }],
          },
        ],
      },
    ]);

    const state = extractPageState('https://example.com', 'Test', snapshot, [], '');

    expect(state.headings).toEqual(['Nested Heading']);
    expect(state.buttons).toEqual([{ text: 'Deep Button', disabled: false, ref: 'e4' }]);
  });
});

describe('computeDelta', () => {
  const baseBefore: PageState = {
    url: 'https://example.com/page1',
    title: 'Page 1',
    headings: ['Welcome', 'Features'],
    formFields: [{ label: 'Email', name: 'email', id: 'email', value: '', type: 'text' }],
    buttons: [{ text: 'Submit', disabled: false }],
    alerts: [],
    visibleText: 'Hello World',
  };

  test('detects URL change', () => {
    const after = { ...baseBefore, url: 'https://example.com/page2' };
    const result = computeDelta(baseBefore, after);

    expect(result.hasChanges).toBe(true);
    expect(result.changes).toContainEqual({
      kind: 'url',
      before: 'https://example.com/page1',
      after: 'https://example.com/page2',
    });
  });

  test('detects title change', () => {
    const after = { ...baseBefore, title: 'Page 2' };
    const result = computeDelta(baseBefore, after);

    expect(result.hasChanges).toBe(true);
    expect(result.changes).toContainEqual({
      kind: 'title',
      before: 'Page 1',
      after: 'Page 2',
    });
  });

  test('detects heading added', () => {
    const after = { ...baseBefore, headings: ['Welcome', 'Features', 'Pricing'] };
    const result = computeDelta(baseBefore, after);

    expect(result.changes).toContainEqual({ kind: 'heading_added', after: 'Pricing' });
  });

  test('detects heading removed', () => {
    const after = { ...baseBefore, headings: ['Welcome'] };
    const result = computeDelta(baseBefore, after);

    expect(result.changes).toContainEqual({ kind: 'heading_removed', before: 'Features' });
  });

  test('detects field value change', () => {
    const after = {
      ...baseBefore,
      formFields: [
        { label: 'Email', name: 'email', id: 'email', value: 'test@example.com', type: 'text' },
      ],
    };
    const result = computeDelta(baseBefore, after);

    expect(result.changes).toContainEqual({
      kind: 'field_changed',
      before: '',
      after: 'test@example.com',
      detail: 'Email',
    });
  });

  test('detects button disabled state change', () => {
    const after = {
      ...baseBefore,
      buttons: [{ text: 'Submit', disabled: true }],
    };
    const result = computeDelta(baseBefore, after);

    expect(result.changes).toContainEqual({
      kind: 'button_changed',
      detail: 'Submit',
      before: 'enabled',
      after: 'disabled',
    });
  });

  test('detects alert added', () => {
    const after = { ...baseBefore, alerts: ['Form submitted'] };
    const result = computeDelta(baseBefore, after);

    expect(result.changes).toContainEqual({ kind: 'alert_added', after: 'Form submitted' });
  });

  test('detects alert removed', () => {
    const before = { ...baseBefore, alerts: ['Error: invalid email'] };
    const after = { ...baseBefore, alerts: [] };
    const result = computeDelta(before, after);

    expect(result.changes).toContainEqual({
      kind: 'alert_removed',
      before: 'Error: invalid email',
    });
  });

  test('returns hasChanges: false when nothing changed', () => {
    const result = computeDelta(baseBefore, { ...baseBefore });

    expect(result.hasChanges).toBe(false);
    expect(result.changes).toEqual([]);
  });

  test('includes before and after states', () => {
    const after = { ...baseBefore, title: 'Changed' };
    const result = computeDelta(baseBefore, after);

    expect(result.before).toBe(baseBefore);
    expect(result.after).toBe(after);
  });
});
