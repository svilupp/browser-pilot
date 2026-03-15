import { describe, expect, test } from 'bun:test';
import {
  buildFingerprintMap,
  createFingerprint,
  fingerprintKey,
  fingerprintSimilarity,
  recoverStaleRef,
  type SemanticFingerprint,
} from '../../src/browser/fingerprint.ts';
import type { SnapshotNode } from '../../src/browser/types.ts';

function makeNode(overrides: Partial<SnapshotNode> = {}): SnapshotNode {
  return {
    role: 'button',
    name: 'Submit',
    ref: 'e1',
    ...overrides,
  };
}

function makeContext(
  overrides: Partial<{ headingTrail: string[]; siblingIndex: number; nearestHeading: string }> = {}
) {
  return {
    headingTrail: [] as string[],
    siblingIndex: 0,
    nearestHeading: '',
    ...overrides,
  };
}

describe('createFingerprint', () => {
  test('creates fingerprint for a button node', () => {
    const node = makeNode();
    const fp = createFingerprint(node, makeContext());

    expect(fp.role).toBe('button');
    expect(fp.name).toBe('Submit');
    expect(fp.label).toBe('Submit');
    expect(fp.valueShape).toBe('');
    expect(fp.siblingIndex).toBe(0);
    expect(fp.sectionPath).toEqual([]);
    expect(fp.stableAttrs).toEqual({});
  });

  test('captures value shape for text value', () => {
    const node = makeNode({ value: 'hello' });
    const fp = createFingerprint(node, makeContext());
    expect(fp.valueShape).toBe('text');
  });

  test('captures heading trail from context', () => {
    const node = makeNode({ role: 'textbox', name: 'Email' });
    const fp = createFingerprint(
      node,
      makeContext({
        headingTrail: ['Login', 'Credentials'],
        nearestHeading: 'Credentials',
        siblingIndex: 2,
      })
    );

    expect(fp.sectionPath).toEqual(['Login', 'Credentials']);
    expect(fp.nearestHeading).toBe('Credentials');
    expect(fp.siblingIndex).toBe(2);
  });

  test('extracts stable attributes from properties', () => {
    const node = makeNode({
      properties: { id: 'email-input', name: 'email', type: 'email' },
    });
    const fp = createFingerprint(node, makeContext());
    expect(fp.stableAttrs).toEqual({ id: 'email-input', name: 'email', type: 'email' });
  });

  test('handles node with no name', () => {
    const node = makeNode({ name: undefined });
    const fp = createFingerprint(node, makeContext());
    expect(fp.name).toBe('');
    expect(fp.label).toBe('');
  });
});

describe('fingerprintKey', () => {
  test('generates key from role, name, and section path', () => {
    const fp = createFingerprint(makeNode(), makeContext({ headingTrail: ['Form'] }));
    const key = fingerprintKey(fp);
    expect(key).toBe('button|Submit|Form');
  });

  test('includes id attribute when present', () => {
    const fp = createFingerprint(makeNode({ properties: { id: 'btn-submit' } }), makeContext());
    const key = fingerprintKey(fp);
    expect(key).toContain('id=btn-submit');
  });

  test('includes name attribute when present', () => {
    const fp = createFingerprint(makeNode({ properties: { name: 'action' } }), makeContext());
    const key = fingerprintKey(fp);
    expect(key).toContain('name=action');
  });
});

describe('fingerprintSimilarity', () => {
  test('identical fingerprints score 1', () => {
    const fp = createFingerprint(makeNode(), makeContext());
    expect(fingerprintSimilarity(fp, fp)).toBe(1);
  });

  test('different roles score 0', () => {
    const a = createFingerprint(makeNode({ role: 'button' }), makeContext());
    const b = createFingerprint(makeNode({ role: 'link' }), makeContext());
    expect(fingerprintSimilarity(a, b)).toBe(0);
  });

  test('same role different name scores lower', () => {
    const a = createFingerprint(makeNode({ name: 'Submit' }), makeContext());
    const b = createFingerprint(makeNode({ name: 'Cancel' }), makeContext());
    const same = fingerprintSimilarity(a, a);
    const diff = fingerprintSimilarity(a, b);
    expect(diff).toBeLessThan(same);
    expect(diff).toBeGreaterThan(0);
  });

  test('case-insensitive name match scores slightly lower than exact', () => {
    const a = createFingerprint(makeNode({ name: 'Submit' }), makeContext());
    const b = createFingerprint(makeNode({ name: 'submit' }), makeContext());
    const exact = fingerprintSimilarity(a, a);
    const caseInsensitive = fingerprintSimilarity(a, b);
    expect(caseInsensitive).toBeLessThan(exact);
    expect(caseInsensitive).toBeGreaterThan(0.5);
  });

  test('matching stable attributes increase score', () => {
    const withId = createFingerprint(makeNode({ properties: { id: 'btn' } }), makeContext());
    const withoutId = createFingerprint(makeNode(), makeContext());
    const withIdDiff = createFingerprint(makeNode({ properties: { id: 'other' } }), makeContext());

    // Same id vs missing id
    const scoreSame = fingerprintSimilarity(withId, withId);
    const scoreMixed = fingerprintSimilarity(withId, withoutId);
    expect(scoreSame).toBeGreaterThan(scoreMixed);

    // Same id vs different id
    const scoreDiffId = fingerprintSimilarity(withId, withIdDiff);
    expect(scoreSame).toBeGreaterThan(scoreDiffId);
  });

  test('empty names do not get name match score', () => {
    const a = createFingerprint(makeNode({ name: undefined }), makeContext());
    const b = createFingerprint(makeNode({ name: undefined }), makeContext());
    const score = fingerprintSimilarity(a, b);
    // Still matches on role, path, sibling index
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

describe('buildFingerprintMap', () => {
  test('indexes interactive nodes by ref', () => {
    const tree: SnapshotNode[] = [
      {
        role: 'main',
        ref: 'e0',
        children: [
          { role: 'button', name: 'OK', ref: 'e1' },
          { role: 'textbox', name: 'Email', ref: 'e2' },
          { role: 'generic', name: '', ref: 'e3' }, // non-interactive
        ],
      },
    ];

    const map = buildFingerprintMap(tree);
    expect(map.has('e1')).toBe(true);
    expect(map.has('e2')).toBe(true);
    expect(map.has('e0')).toBe(false); // main is not interactive
    expect(map.has('e3')).toBe(false); // generic is not interactive
  });

  test('tracks heading trail through tree', () => {
    const tree: SnapshotNode[] = [
      {
        role: 'heading',
        name: 'Login',
        ref: 'h1',
        children: [{ role: 'button', name: 'Submit', ref: 'e1' }],
      },
    ];

    const map = buildFingerprintMap(tree);
    const fp = map.get('e1')!;
    expect(fp.sectionPath).toEqual(['Login']);
    expect(fp.nearestHeading).toBe('Login');
  });

  test('assigns sibling indices per role', () => {
    const tree: SnapshotNode[] = [
      {
        role: 'main',
        ref: 'e0',
        children: [
          { role: 'button', name: 'A', ref: 'e1' },
          { role: 'button', name: 'B', ref: 'e2' },
          { role: 'link', name: 'C', ref: 'e3' },
          { role: 'button', name: 'D', ref: 'e4' },
        ],
      },
    ];

    const map = buildFingerprintMap(tree);
    expect(map.get('e1')!.siblingIndex).toBe(0);
    expect(map.get('e2')!.siblingIndex).toBe(1);
    expect(map.get('e3')!.siblingIndex).toBe(0); // first link
    expect(map.get('e4')!.siblingIndex).toBe(2);
  });

  test('handles all interactive roles', () => {
    const roles = [
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
    ];
    const tree: SnapshotNode[] = roles.map((role, i) => ({
      role,
      name: `Item ${i}`,
      ref: `e${i}`,
    }));

    const map = buildFingerprintMap(tree);
    expect(map.size).toBe(roles.length);
  });
});

describe('recoverStaleRef', () => {
  function buildMap(
    entries: Array<[string, Partial<SemanticFingerprint>]>
  ): Map<string, SemanticFingerprint> {
    const defaults: SemanticFingerprint = {
      role: 'button',
      name: '',
      valueShape: '',
      label: '',
      stableAttrs: {},
      nearestHeading: '',
      siblingIndex: 0,
      sectionPath: [],
    };
    const map = new Map<string, SemanticFingerprint>();
    for (const [ref, partial] of entries) {
      map.set(ref, { ...defaults, ...partial });
    }
    return map;
  }

  test('recovers exact match with high confidence', () => {
    const stale: SemanticFingerprint = {
      role: 'button',
      name: 'Submit',
      valueShape: '',
      label: 'Submit',
      stableAttrs: {},
      nearestHeading: 'Form',
      siblingIndex: 0,
      sectionPath: ['Form'],
    };

    const current = buildMap([
      ['e10', { role: 'button', name: 'Submit', sectionPath: ['Form'], nearestHeading: 'Form' }],
      ['e11', { role: 'button', name: 'Cancel', sectionPath: ['Form'], nearestHeading: 'Form' }],
    ]);

    const result = recoverStaleRef(stale, current);
    expect(result).not.toBeNull();
    expect(result!.ref).toBe('e10');
    expect(result!.confidence).toBeGreaterThan(0.7);
  });

  test('returns null when below threshold', () => {
    const stale: SemanticFingerprint = {
      role: 'button',
      name: 'Submit',
      valueShape: '',
      label: 'Submit',
      stableAttrs: { id: 'old-id' },
      nearestHeading: 'Form',
      siblingIndex: 0,
      sectionPath: ['Form'],
    };

    const current = buildMap([
      [
        'e10',
        {
          role: 'button',
          name: 'Different',
          sectionPath: ['Other'],
          stableAttrs: { id: 'new-id' },
        },
      ],
    ]);

    const result = recoverStaleRef(stale, current, 0.9);
    expect(result).toBeNull();
  });

  test('returns null for ambiguous matches', () => {
    const stale: SemanticFingerprint = {
      role: 'button',
      name: 'OK',
      valueShape: '',
      label: 'OK',
      stableAttrs: {},
      nearestHeading: '',
      siblingIndex: 0,
      sectionPath: [],
    };

    // Two identical buttons — ambiguous
    const current = buildMap([
      ['e10', { role: 'button', name: 'OK' }],
      ['e11', { role: 'button', name: 'OK' }],
    ]);

    const result = recoverStaleRef(stale, current);
    expect(result).toBeNull();
  });

  test('returns null when no candidates exist', () => {
    const stale: SemanticFingerprint = {
      role: 'button',
      name: 'Submit',
      valueShape: '',
      label: 'Submit',
      stableAttrs: {},
      nearestHeading: '',
      siblingIndex: 0,
      sectionPath: [],
    };

    const current = new Map<string, SemanticFingerprint>();
    expect(recoverStaleRef(stale, current)).toBeNull();
  });

  test('distinguishes by stable attributes when names match', () => {
    const stale: SemanticFingerprint = {
      role: 'textbox',
      name: 'Email',
      valueShape: 'text',
      label: 'Email',
      stableAttrs: { id: 'email-field', name: 'email' },
      nearestHeading: 'Login',
      siblingIndex: 0,
      sectionPath: ['Login'],
    };

    const current = buildMap([
      [
        'e20',
        {
          role: 'textbox',
          name: 'Email',
          stableAttrs: { id: 'email-field', name: 'email' },
          sectionPath: ['Login'],
          nearestHeading: 'Login',
        },
      ],
      [
        'e21',
        {
          role: 'textbox',
          name: 'Email',
          stableAttrs: { id: 'confirm-email', name: 'confirm_email' },
          sectionPath: ['Confirmation'],
          nearestHeading: 'Confirmation',
        },
      ],
    ]);

    const result = recoverStaleRef(stale, current);
    expect(result).not.toBeNull();
    expect(result!.ref).toBe('e20');
  });
});
