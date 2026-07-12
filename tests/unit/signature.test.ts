import { describe, expect, test } from 'bun:test';
import {
  captureStructureSignature,
  DEFAULT_MASK_ROLES,
  type StructureSignatureOptions,
} from '../../src/browser/signature.ts';
import type { PageSnapshot, SnapshotNode } from '../../src/browser/types.ts';

function makeSnapshot(
  accessibilityTree: SnapshotNode[],
  url = 'https://example.com/dashboard'
): PageSnapshot {
  return {
    url,
    title: 'Test',
    timestamp: new Date().toISOString(),
    accessibilityTree,
    interactiveElements: [],
    text: '',
  };
}

/** Extract just the hash half of a `"${urlPath}|${hash}"` signature. */
function hashOf(sig: string): string {
  return sig.split('|')[1] ?? '';
}

describe('captureStructureSignature', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal documenting the signature output shape
  test('returns "${urlPath}|${hash}" shape with pathname only', () => {
    const sig = captureStructureSignature(
      makeSnapshot([{ ref: 'e1', role: 'button', name: 'Go' }], 'https://example.com/app/page')
    );
    expect(sig.startsWith('/app/page|')).toBe(true);
    expect(sig.split('|').length).toBe(2);
  });

  test('is EQUAL across a content-only change (same role tree, different names/text)', () => {
    const before = makeSnapshot([
      {
        ref: 'e1',
        role: 'form',
        name: 'Login',
        children: [
          { ref: 'e2', role: 'textbox', name: 'Username' },
          { ref: 'e3', role: 'button', name: 'Submit' },
        ],
      },
    ]);
    const after = makeSnapshot([
      {
        ref: 'x9',
        role: 'form',
        name: 'Sign up', // different name
        children: [
          { ref: 'x8', role: 'textbox', name: 'Email address', value: 'a@b.com' }, // different name/value
          { ref: 'x7', role: 'button', name: 'Create account' }, // different name
        ],
      },
    ]);

    expect(captureStructureSignature(after)).toBe(captureStructureSignature(before));
  });

  test('is DIFFERENT across a structural/layout change (different role tree)', () => {
    const before = makeSnapshot([
      {
        ref: 'e1',
        role: 'form',
        name: 'Login',
        children: [{ ref: 'e2', role: 'textbox', name: 'Username' }],
      },
    ]);
    // Adds a second child -> structural change.
    const after = makeSnapshot([
      {
        ref: 'e1',
        role: 'form',
        name: 'Login',
        children: [
          { ref: 'e2', role: 'textbox', name: 'Username' },
          { ref: 'e3', role: 'textbox', name: 'Password' },
        ],
      },
    ]);

    expect(captureStructureSignature(after)).not.toBe(captureStructureSignature(before));
  });

  test('is DIFFERENT when nesting depth changes', () => {
    const flat = makeSnapshot([
      { ref: 'e1', role: 'group', name: 'A' },
      { ref: 'e2', role: 'button', name: 'B' },
    ]);
    const nested = makeSnapshot([
      { ref: 'e1', role: 'group', name: 'A', children: [{ ref: 'e2', role: 'button', name: 'B' }] },
    ]);

    expect(captureStructureSignature(nested)).not.toBe(captureStructureSignature(flat));
  });

  test('strips query and fragment: same path with different ?query/#frag is EQUAL', () => {
    const tree: SnapshotNode[] = [{ ref: 'e1', role: 'button', name: 'Go' }];
    const query = captureStructureSignature(
      makeSnapshot(tree, 'https://example.com/app?token=1&x=2')
    );
    const frag = captureStructureSignature(makeSnapshot(tree, 'https://example.com/app#section'));
    const plain = captureStructureSignature(makeSnapshot(tree, 'https://example.com/app'));

    expect(query).toBe(plain);
    expect(frag).toBe(plain);
    expect(query.startsWith('/app|')).toBe(true);
  });

  test('maskRoles masks a status node so adding/removing it does not change the signature', () => {
    const withoutStatus = makeSnapshot([
      { ref: 'e1', role: 'heading', name: 'Cart' },
      { ref: 'e2', role: 'button', name: 'Checkout' },
    ]);
    const withStatus = makeSnapshot([
      { ref: 'e1', role: 'heading', name: 'Cart' },
      { ref: 'e9', role: 'status', name: 'Saved 2 seconds ago' }, // ephemeral live region
      { ref: 'e2', role: 'button', name: 'Checkout' },
    ]);

    expect(captureStructureSignature(withStatus)).toBe(captureStructureSignature(withoutStatus));
    // 'status' is one of the defaults.
    expect(DEFAULT_MASK_ROLES).toContain('status');
  });

  test('masks an alert node (default) including its subtree', () => {
    const base = makeSnapshot([{ ref: 'e1', role: 'main', name: 'Content' }]);
    const withAlert = makeSnapshot([
      { ref: 'e1', role: 'main', name: 'Content' },
      {
        ref: 'e2',
        role: 'alert',
        name: 'Error',
        children: [{ ref: 'e3', role: 'button', name: 'Dismiss' }],
      },
    ]);

    expect(captureStructureSignature(withAlert)).toBe(captureStructureSignature(base));
  });

  test('custom maskRoles overrides the default set', () => {
    const opts: StructureSignatureOptions = { maskRoles: ['banner'] };
    const withBanner = makeSnapshot([
      { ref: 'e0', role: 'banner', name: 'Top' },
      { ref: 'e1', role: 'button', name: 'Go' },
    ]);
    const withoutBanner = makeSnapshot([{ ref: 'e1', role: 'button', name: 'Go' }]);

    expect(captureStructureSignature(withBanner, opts)).toBe(
      captureStructureSignature(withoutBanner, opts)
    );
  });

  test('includeState:true makes a disabled<->enabled flip change the signature', () => {
    const enabled = makeSnapshot([{ ref: 'e1', role: 'button', name: 'Submit', disabled: false }]);
    const disabled = makeSnapshot([{ ref: 'e1', role: 'button', name: 'Submit', disabled: true }]);

    const opts: StructureSignatureOptions = { includeState: true };
    expect(captureStructureSignature(disabled, opts)).not.toBe(
      captureStructureSignature(enabled, opts)
    );
  });

  test('default (includeState omitted) ignores a disabled<->enabled flip', () => {
    const enabled = makeSnapshot([{ ref: 'e1', role: 'button', name: 'Submit', disabled: false }]);
    const disabled = makeSnapshot([{ ref: 'e1', role: 'button', name: 'Submit', disabled: true }]);

    expect(captureStructureSignature(disabled)).toBe(captureStructureSignature(enabled));
  });

  test('includeState:true reflects a checked flip', () => {
    const unchecked = makeSnapshot([
      { ref: 'e1', role: 'checkbox', name: 'Agree', checked: false },
    ]);
    const checked = makeSnapshot([{ ref: 'e1', role: 'checkbox', name: 'Agree', checked: true }]);

    const opts: StructureSignatureOptions = { includeState: true };
    expect(captureStructureSignature(checked, opts)).not.toBe(
      captureStructureSignature(unchecked, opts)
    );
    // Without state bits the two are identical.
    expect(captureStructureSignature(checked)).toBe(captureStructureSignature(unchecked));
  });

  test('depth cap ignores nodes deeper than the limit', () => {
    const shallow = makeSnapshot([
      { ref: 'e1', role: 'group', name: 'A', children: [{ ref: 'e2', role: 'list', name: 'L' }] },
    ]);
    // Same tree down to depth 1, but with extra deep descendants.
    const deep = makeSnapshot([
      {
        ref: 'e1',
        role: 'group',
        name: 'A',
        children: [
          {
            ref: 'e2',
            role: 'list',
            name: 'L',
            children: [{ ref: 'e3', role: 'listitem', name: 'Row' }],
          },
        ],
      },
    ]);

    const opts: StructureSignatureOptions = { depth: 1 };
    expect(captureStructureSignature(deep, opts)).toBe(captureStructureSignature(shallow, opts));
    // Without a depth cap the deep descendant changes the signature.
    expect(captureStructureSignature(deep)).not.toBe(captureStructureSignature(shallow));
  });

  test('maskSelectors prunes a node matched by role/name', () => {
    const base = makeSnapshot([{ ref: 'e1', role: 'main', name: 'Content' }]);
    const withExtra = makeSnapshot([
      { ref: 'e1', role: 'main', name: 'Content' },
      { ref: 'e2', role: 'region', name: 'Ads' },
    ]);

    const opts: StructureSignatureOptions = { maskSelectors: ['region/Ads'] };
    expect(captureStructureSignature(withExtra, opts)).toBe(captureStructureSignature(base, opts));
  });

  test('accepts a Page-like object and resolves to a signature', async () => {
    const snapshot = makeSnapshot([{ ref: 'e1', role: 'button', name: 'Go' }]);
    const pageLike = {
      snapshot: async () => snapshot,
    };
    // The Page overload returns a promise.
    const sig = await captureStructureSignature(pageLike as never);
    expect(sig).toBe(captureStructureSignature(snapshot));
  });

  test('empty accessibility tree still yields a stable signature', () => {
    const a = captureStructureSignature(makeSnapshot([]));
    const b = captureStructureSignature(makeSnapshot([]));
    expect(a).toBe(b);
    expect(hashOf(a)).toBeTruthy();
  });
});
