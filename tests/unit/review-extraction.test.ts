import { describe, expect, test } from 'bun:test';
import { extractReview } from '../../src/browser/review.ts';
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

describe('extractReview', () => {
  test('extracts headings from snapshot', () => {
    const snapshot = makeSnapshot([
      { role: 'heading', name: 'Order Summary', ref: 'e1' },
      { role: 'heading', name: 'Payment Details', ref: 'e2' },
    ]);

    const review = extractReview('https://shop.com/order', 'Order', snapshot, [], '');

    expect(review.url).toBe('https://shop.com/order');
    expect(review.title).toBe('Order');
    expect(review.headings).toEqual(['Order Summary', 'Payment Details']);
  });

  test('extracts alerts from snapshot', () => {
    const snapshot = makeSnapshot([
      { role: 'alert', name: 'Payment declined', ref: 'e1' },
      { role: 'alert', name: 'Please try again', ref: 'e2' },
    ]);

    const review = extractReview('https://example.com', 'Test', snapshot, [], '');

    expect(review.alerts).toEqual(['Payment declined', 'Please try again']);
  });

  test('extracts status labels from snapshot', () => {
    const snapshot = makeSnapshot([
      { role: 'status', name: 'Order: Processing', ref: 'e1' },
      { role: 'status', name: 'Delivery: Pending', ref: 'e2' },
    ]);

    const review = extractReview('https://example.com', 'Test', snapshot, [], '');

    expect(review.statusLabels).toEqual(['Order: Processing', 'Delivery: Pending']);
  });

  test('extracts table data from grid/table roles', () => {
    const tableNode: SnapshotNode = {
      role: 'table',
      ref: 'e1',
      children: [
        { role: 'columnheader', name: 'Item', ref: 'e2' },
        { role: 'columnheader', name: 'Price', ref: 'e3' },
        {
          role: 'row',
          ref: 'e4',
          children: [
            { role: 'cell', name: 'Widget', ref: 'e5' },
            { role: 'cell', name: '$9.99', ref: 'e6' },
          ],
        },
        {
          role: 'row',
          ref: 'e7',
          children: [
            { role: 'cell', name: 'Gadget', ref: 'e8' },
            { role: 'cell', name: '$19.99', ref: 'e9' },
          ],
        },
      ],
    };

    const snapshot = makeSnapshot([tableNode]);
    const review = extractReview('https://example.com', 'Test', snapshot, [], '');

    expect(review.tables).toHaveLength(1);
    expect(review.tables[0]!.headers).toEqual(['Item', 'Price']);
    expect(review.tables[0]!.rows).toEqual([
      ['Widget', '$9.99'],
      ['Gadget', '$19.99'],
    ]);
  });

  test('extracts table from grid role', () => {
    const gridNode: SnapshotNode = {
      role: 'grid',
      ref: 'e1',
      children: [
        {
          role: 'row',
          ref: 'e2',
          children: [
            { role: 'gridcell', name: 'A1', ref: 'e3' },
            { role: 'gridcell', name: 'B1', ref: 'e4' },
          ],
        },
      ],
    };

    const snapshot = makeSnapshot([gridNode]);
    const review = extractReview('https://example.com', 'Test', snapshot, [], '');

    expect(review.tables).toHaveLength(1);
    expect(review.tables[0]!.rows).toEqual([['A1', 'B1']]);
  });

  test('skips table with no rows', () => {
    const emptyTable: SnapshotNode = {
      role: 'table',
      ref: 'e1',
      children: [{ role: 'columnheader', name: 'Col', ref: 'e2' }],
    };

    const snapshot = makeSnapshot([emptyTable]);
    const review = extractReview('https://example.com', 'Test', snapshot, [], '');

    expect(review.tables).toHaveLength(0);
  });

  test('extracts key-value pairs from text patterns', () => {
    const pageText = `
Order Number: 12345
Status: Shipped
Total: $29.98
Customer: John Doe
not a key value pair
lowercase: should not match
    `.trim();

    const review = extractReview('https://example.com', 'Test', makeSnapshot([]), [], pageText);

    expect(review.keyValues).toContainEqual({ key: 'Order Number', value: '12345' });
    expect(review.keyValues).toContainEqual({ key: 'Status', value: 'Shipped' });
    expect(review.keyValues).toContainEqual({ key: 'Total', value: '$29.98' });
    expect(review.keyValues).toContainEqual({ key: 'Customer', value: 'John Doe' });
    // lowercase lines should not match
    expect(review.keyValues.find((kv) => kv.key === 'lowercase')).toBeUndefined();
  });

  test('caps key-value extraction at 20 items', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Item${i}: value${i}`).join('\n');

    const review = extractReview('https://example.com', 'Test', makeSnapshot([]), [], lines);

    expect(review.keyValues.length).toBeLessThanOrEqual(20);
  });

  test('extracts form entries with disabled state', () => {
    const forms: FormField[] = [
      makeFormField({ label: 'Name', value: 'Alice', type: 'text', disabled: false }),
      makeFormField({ label: 'ID', value: '123', type: 'text', disabled: true }),
    ];

    const review = extractReview('https://example.com', 'Test', makeSnapshot([]), forms, '');

    expect(review.forms).toEqual([
      { label: 'Name', value: 'Alice', type: 'text', disabled: false },
      { label: 'ID', value: '123', type: 'text', disabled: true },
    ]);
  });

  test('extracts term/definition key-value pairs', () => {
    const snapshot = makeSnapshot([
      { role: 'term', name: 'Color', ref: 'e1' },
      { role: 'definition', name: 'Red', ref: 'e2' },
    ]);

    const review = extractReview('https://example.com', 'Test', snapshot, [], '');

    expect(review.keyValues).toContainEqual({ key: 'Color', value: 'Red' });
  });

  test('returns complete structure with empty sections', () => {
    const review = extractReview('https://example.com', 'Test', makeSnapshot([]), [], '');

    expect(review).toEqual({
      url: 'https://example.com',
      title: 'Test',
      headings: [],
      forms: [],
      alerts: [],
      summaryCards: [],
      tables: [],
      keyValues: [],
      statusLabels: [],
    });
  });
});
