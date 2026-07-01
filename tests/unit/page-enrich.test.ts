/**
 * Unit tests for the pure helpers behind `snapshot({ attributes: true })`
 * enrichment (Phase 7 Change 3a): `isStableClassName` and
 * `extractAttributesByBackendId`.
 *
 * The live CDP round-trip (`enrichSnapshotAttributes`), `resolveAll`, and
 * `diagnose` need a real Chrome.
 * // integration: covered in tests/integration in the next wave
 */

import { describe, expect, test } from 'bun:test';
import {
  extractAttributesByBackendId,
  type FlatDomNode,
  isStableClassName,
} from '../../src/browser/page.ts';
import type { InteractiveElement } from '../../src/browser/types.ts';

// Mirrors Page.ENRICHED_ATTRIBUTE_NAMES (private static) so the extraction test
// exercises the same wanted-set the production pass uses.
const WANTED = [
  'id',
  'data-testid',
  'data-test',
  'data-test-id',
  'data-qa',
  'name',
  'type',
  'placeholder',
  'role',
  'aria-label',
] as const;

describe('isStableClassName', () => {
  test('accepts short, human-authored semantic names', () => {
    for (const cls of [
      'btn',
      'primary',
      'card',
      'button',
      'header',
      'sidebar',
      'nav-link',
      'nav-container',
      'text-center',
      'is-active',
    ]) {
      expect(isStableClassName(cls)).toBe(true);
    }
  });

  test('rejects CSS-modules hashes', () => {
    expect(isStableClassName('Button_abc123')).toBe(false);
    expect(isStableClassName('Header__3xY7z')).toBe(false);
    expect(isStableClassName('MuiButton-abc123')).toBe(false);
  });

  test('rejects styled-components / emotion suffixes', () => {
    expect(isStableClassName('css-1a2b3c')).toBe(false);
    expect(isStableClassName('sc-bdVaJa')).toBe(false);
  });

  test('rejects atomic gibberish, purely-numeric and over-long tokens', () => {
    expect(isStableClassName('x1nrf0dw')).toBe(false);
    expect(isStableClassName('12345')).toBe(false);
    expect(isStableClassName('a'.repeat(40))).toBe(false);
  });

  test('rejects empty / whitespace tokens', () => {
    expect(isStableClassName('')).toBe(false);
    expect(isStableClassName('   ')).toBe(false);
  });
});

describe('extractAttributesByBackendId', () => {
  const tree: FlatDomNode = {
    backendNodeId: 1,
    nodeName: '#document',
    children: [
      {
        backendNodeId: 10,
        nodeName: 'BUTTON',
        // stable classes kept ('btn primary'), hashed 'Button_abc123' dropped.
        attributes: [
          'id',
          'submit-btn',
          'class',
          'btn primary Button_abc123',
          'data-testid',
          'submit',
          'role',
          'button',
        ],
      },
      {
        backendNodeId: 11,
        nodeName: 'INPUT',
        // only class is the atomic 'x1nrf0dw' -> no class key survives.
        attributes: ['name', 'email', 'type', 'email', 'class', 'x1nrf0dw'],
      },
      {
        backendNodeId: 12,
        nodeName: 'DIV',
        attributes: ['class', 'wrapper'],
      },
      {
        backendNodeId: 13,
        nodeName: 'SPAN',
        // no wanted attr and no class -> omitted from the map entirely.
        attributes: ['data-foo', 'bar'],
      },
      {
        backendNodeId: 20,
        nodeName: 'MY-WIDGET',
        shadowRoots: [
          {
            backendNodeId: 21,
            nodeName: '#document-fragment',
            children: [
              { backendNodeId: 22, nodeName: 'SPAN', attributes: ['data-qa', 'shadow-el'] },
            ],
          },
        ],
      },
      {
        backendNodeId: 30,
        nodeName: 'IFRAME',
        contentDocument: {
          backendNodeId: 31,
          nodeName: '#document',
          children: [{ backendNodeId: 32, nodeName: 'A', attributes: ['id', 'iframe-child'] }],
        },
      },
    ],
  };

  const map = extractAttributesByBackendId(tree, WANTED);

  test('copies wanted attributes and keeps only stable classes', () => {
    expect(map.get(10)).toEqual({
      id: 'submit-btn',
      class: 'btn primary',
      'data-testid': 'submit',
      role: 'button',
    });
  });

  test('drops unstable-only class, keeps other wanted attrs', () => {
    expect(map.get(11)).toEqual({ name: 'email', type: 'email' });
  });

  test('keeps a lone stable class', () => {
    expect(map.get(12)).toEqual({ class: 'wrapper' });
  });

  test('omits nodes with no relevant attributes', () => {
    expect(map.has(13)).toBe(false);
    // container-only nodes (no attributes) are absent too.
    expect(map.has(1)).toBe(false);
    expect(map.has(20)).toBe(false);
  });

  test('pierces shadow roots and iframe content documents', () => {
    expect(map.get(22)).toEqual({ 'data-qa': 'shadow-el' });
    expect(map.get(32)).toEqual({ id: 'iframe-child' });
  });

  test('tolerates missing/odd inputs', () => {
    expect(extractAttributesByBackendId(undefined, WANTED).size).toBe(0);
    // odd-length attribute array: trailing name with no value is skipped.
    const odd: FlatDomNode = { backendNodeId: 5, attributes: ['id', 'ok', 'name'] };
    expect(extractAttributesByBackendId(odd, WANTED).get(5)).toEqual({ id: 'ok' });
  });
});

describe('attribute mapping onto interactive elements', () => {
  // Replicates the ref -> backendNodeId -> el.attributes assignment that
  // enrichSnapshotAttributes performs after the batched extraction, so the
  // mapping logic is verified without a browser.
  test('assigns extracted attributes to elements by backendNodeId', () => {
    const tree: FlatDomNode = {
      backendNodeId: 1,
      children: [
        { backendNodeId: 100, attributes: ['data-testid', 'login'] },
        { backendNodeId: 200, attributes: ['id', 'email', 'name', 'email'] },
      ],
    };
    const byBackendId = extractAttributesByBackendId(tree, WANTED);

    const refToBackendId = new Map<string, number>([
      ['e1', 100],
      ['e2', 200],
      ['e3', 999], // no matching DOM node -> stays unenriched
    ]);
    const elements: InteractiveElement[] = [
      { ref: 'e1', role: 'button', name: 'Login', selector: 'ref:e1' },
      { ref: 'e2', role: 'textbox', name: 'Email', selector: 'ref:e2' },
      { ref: 'e3', role: 'link', name: 'Missing', selector: 'ref:e3' },
    ];

    for (const el of elements) {
      const backendId = refToBackendId.get(el.ref);
      if (backendId === undefined) continue;
      const attrs = byBackendId.get(backendId);
      if (attrs && Object.keys(attrs).length > 0) el.attributes = attrs;
    }

    expect(elements[0]?.attributes).toEqual({ 'data-testid': 'login' });
    expect(elements[1]?.attributes).toEqual({ id: 'email', name: 'email' });
    expect(elements[2]?.attributes).toBeUndefined();
  });
});
