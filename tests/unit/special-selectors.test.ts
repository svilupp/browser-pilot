/**
 * Unit tests for the special-selector grammar + finder (no Chrome).
 *
 * Two layers are covered:
 *  1. The pure parsers ({@link parseRoleSelector} / {@link parseTextSelector})
 *     understand the new positional `[N]` index and the `within(...)` / `>>`
 *     container-scope prefixes.
 *  2. The in-page finder script ({@link SPECIAL_SELECTOR_SCRIPT}) is evaluated
 *     against a tiny fake DOM so we can assert that an indexed `role:` query
 *     returns the correct Nth element in DOM order and that a scoped query is
 *     restricted to descendants of its container — the exact capability the
 *     "8 identical unnamed buttons" benchmark needs.
 */

import { describe, expect, it } from 'bun:test';
import {
  parseRoleSelector,
  parseTextSelector,
  SPECIAL_SELECTOR_SCRIPT,
} from '../../src/browser/special-selectors.ts';

// --------------------------------------------------------------------------
// Minimal fake DOM: just enough surface for the finder script to run.
// --------------------------------------------------------------------------

interface ElSpec {
  tag: string;
  attrs?: Record<string, string>;
  text?: string;
  visible?: boolean;
  cursor?: string;
  children?: ElSpec[];
}

class FakeElement {
  tagName: string;
  private attrs: Record<string, string>;
  text: string;
  visible: boolean;
  cursor: string;
  children: FakeElement[];
  shadowRoot: null = null;

  constructor(spec: ElSpec) {
    this.tagName = spec.tag.toUpperCase();
    this.attrs = spec.attrs ?? {};
    this.text = spec.text ?? '';
    this.visible = spec.visible ?? true;
    this.cursor = spec.cursor ?? 'auto';
    this.children = (spec.children ?? []).map((c) => new FakeElement(c));
  }

  getAttribute(name: string): string | null {
    return name in this.attrs ? (this.attrs[name] as string) : null;
  }

  hasAttribute(name: string): boolean {
    return name in this.attrs;
  }

  get innerText(): string {
    return this.text;
  }

  get textContent(): string {
    return this.text;
  }

  getBoundingClientRect() {
    return this.visible
      ? { x: 0, y: 0, width: 20, height: 20 }
      : { x: 0, y: 0, width: 0, height: 0 };
  }

  /** Pre-order list of all descendants (excludes self). */
  descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of this.children) {
      out.push(child);
      out.push(...child.descendants());
    }
    return out;
  }

  querySelectorAll(sel: string): FakeElement[] {
    if (sel === '*') return this.descendants();
    return this.descendants().filter((el) => matchesSimple(el, sel));
  }

  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

/** Match a single compound selector: tag#id.class[attr="value"]. */
function matchesSimple(el: FakeElement, selector: string): boolean {
  const sel = selector.trim();
  const tokens = sel.match(/[#.]?[\w-]+|\[[^\]]+\]/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith('#')) {
      if (el.getAttribute('id') !== token.slice(1)) return false;
    } else if (token.startsWith('.')) {
      const classes = (el.getAttribute('class') ?? '').split(/\s+/);
      if (!classes.includes(token.slice(1))) return false;
    } else if (token.startsWith('[')) {
      const m = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(token);
      if (!m) return false;
      const name = m[1] as string;
      if (!el.hasAttribute(name)) return false;
      if (m[2] !== undefined && el.getAttribute(name) !== m[2]) return false;
    } else {
      if (el.tagName !== token.toUpperCase()) return false;
    }
  }
  return true;
}

/** Build a fake `document` whose documentElement is the given <html> spec. */
function makeDocument(htmlSpec: ElSpec) {
  const documentElement = new FakeElement(htmlSpec);
  return {
    documentElement,
    querySelector: (sel: string) =>
      matchesSimple(documentElement, sel) ? documentElement : documentElement.querySelector(sel),
    querySelectorAll: (sel: string) => {
      const all = [documentElement, ...documentElement.descendants()];
      return sel === '*' ? all : all.filter((el) => matchesSimple(el, sel));
    },
    getElementById: (id: string) =>
      documentElement.descendants().find((el) => el.getAttribute('id') === id) ?? null,
  };
}

/** Compile the finder script against a fake document. */
function makeFinders(doc: ReturnType<typeof makeDocument>) {
  const getComputedStyle = (el: FakeElement) => ({
    display: el.visible ? 'block' : 'none',
    visibility: 'visible',
    opacity: '1',
    cursor: el.cursor,
  });
  const factory = new Function(
    'document',
    'getComputedStyle',
    `${SPECIAL_SELECTOR_SCRIPT}\nreturn { bpFindByRole: bpFindByRole, bpFindByText: bpFindByText };`
  );
  return factory(doc, getComputedStyle) as {
    bpFindByRole: (
      role: string,
      name: string,
      includeHidden: boolean,
      index: number,
      scope: string | null
    ) => FakeElement | null;
    bpFindByText: (
      query: string,
      exact: boolean,
      includeHidden: boolean,
      index: number,
      scope: string | null
    ) => FakeElement | null;
  };
}

/** Toolbar of N unnamed buttons, each carrying a unique data-cmd. */
function iconToolbar(prefix: string, count: number, containerClass: string): ElSpec {
  return {
    tag: 'div',
    attrs: { class: `toolbar ${containerClass}` },
    children: Array.from({ length: count }, (_, i) => ({
      tag: 'button',
      attrs: { 'data-cmd': `${prefix}${i + 1}` },
    })),
  };
}

// --------------------------------------------------------------------------
// Parser tests (pure).
// --------------------------------------------------------------------------

describe('parseRoleSelector — index + scope grammar', () => {
  it('parses a bare role (legacy, no index/scope)', () => {
    expect(parseRoleSelector('role:button')).toEqual({
      role: 'button',
      name: undefined,
      index: undefined,
      scope: undefined,
    });
  });

  it('parses role + quoted name (legacy)', () => {
    const parsed = parseRoleSelector('role:button:"Save"');
    expect(parsed?.role).toBe('button');
    expect(parsed?.name).toBe('Save');
    expect(parsed?.index).toBeUndefined();
  });

  it('parses a trailing 1-based index', () => {
    expect(parseRoleSelector('role:button[2]')).toMatchObject({ role: 'button', index: 2 });
  });

  it('parses index alongside a name', () => {
    expect(parseRoleSelector('role:button:"Delete"[3]')).toMatchObject({
      role: 'button',
      name: 'Delete',
      index: 3,
    });
  });

  it('does not treat a bracketed value inside a quoted name as an index', () => {
    const parsed = parseRoleSelector('role:button:"foo[2]"');
    expect(parsed?.name).toBe('foo[2]');
    expect(parsed?.index).toBeUndefined();
  });

  it('parses a within(...) scope prefix', () => {
    expect(parseRoleSelector('within(.toolbar) role:button[2]')).toMatchObject({
      role: 'button',
      index: 2,
      scope: '.toolbar',
    });
  });

  it('parses a >> scope prefix', () => {
    expect(parseRoleSelector('.toolbar >> role:button[2]')).toMatchObject({
      role: 'button',
      index: 2,
      scope: '.toolbar',
    });
  });

  it('returns null for non-role selectors', () => {
    expect(parseRoleSelector('[data-cmd="c2"]')).toBeNull();
    expect(parseRoleSelector('.toolbar >> .btn')).toBeNull();
  });

  it('parses the [name="..."] bracket alias', () => {
    expect(parseRoleSelector('role:button[name="More actions"]')).toMatchObject({
      role: 'button',
      name: 'More actions',
    });
  });

  it('parses the bracket alias with single quotes', () => {
    expect(parseRoleSelector("role:link[name='GAL-1001']")).toMatchObject({
      role: 'link',
      name: 'GAL-1001',
    });
  });

  it('parses a bare (unquoted) bracket name', () => {
    expect(parseRoleSelector('role:button[name=Save]')).toMatchObject({
      role: 'button',
      name: 'Save',
    });
  });

  it('parses the bracket alias alongside an index and scope', () => {
    expect(parseRoleSelector('within(.toolbar) role:button[name="Delete"][3]')).toMatchObject({
      role: 'button',
      name: 'Delete',
      index: 3,
      scope: '.toolbar',
    });
  });
});

describe('parseTextSelector — index + scope grammar', () => {
  it('parses a plain text query (legacy)', () => {
    expect(parseTextSelector('text:Save')).toMatchObject({ query: 'Save', exact: false });
  });

  it('parses exact + index', () => {
    expect(parseTextSelector('text:="Add"[2]')).toMatchObject({
      query: 'Add',
      exact: true,
      index: 2,
    });
  });

  it('parses a scoped text query', () => {
    expect(parseTextSelector('within(#panel) text:"Add"[3]')).toMatchObject({
      query: 'Add',
      index: 3,
      scope: '#panel',
    });
  });

  it('does not treat >> inside a quoted text query as a scope separator', () => {
    const parsed = parseTextSelector('text:">>"');
    expect(parsed?.query).toBe('>>');
    expect(parsed?.scope).toBeUndefined();
  });

  it('leaves a plain (non-special) >> CSS selector unparsed', () => {
    // `.a >> .b` is deprecated CSS, not a scoped special selector.
    expect(parseTextSelector('.a >> .b')).toBeNull();
    expect(parseRoleSelector('.a >> .b')).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Finder tests (fake DOM).
// --------------------------------------------------------------------------

describe('bpFindByRole — positional index', () => {
  const doc = makeDocument({
    tag: 'html',
    children: [{ tag: 'body', children: [iconToolbar('c', 8, 'editor')] }],
  });
  const { bpFindByRole } = makeFinders(doc);

  it('returns the Nth unnamed button in DOM order', () => {
    expect(bpFindByRole('button', '', false, 2, null)?.getAttribute('data-cmd')).toBe('c2');
    expect(bpFindByRole('button', '', false, 5, null)?.getAttribute('data-cmd')).toBe('c5');
    expect(bpFindByRole('button', '', false, 8, null)?.getAttribute('data-cmd')).toBe('c8');
  });

  it('returns the first match when index is 1', () => {
    expect(bpFindByRole('button', '', false, 1, null)?.getAttribute('data-cmd')).toBe('c1');
  });

  it('returns null when the index is out of range', () => {
    expect(bpFindByRole('button', '', false, 9, null)).toBeNull();
  });

  it('legacy (index 0) still returns a single element', () => {
    expect(bpFindByRole('button', '', false, 0, null)).not.toBeNull();
  });
});

describe('bpFindByRole — container scope', () => {
  const doc = makeDocument({
    tag: 'html',
    children: [
      {
        tag: 'body',
        children: [iconToolbar('a', 3, 'editor'), iconToolbar('b', 3, 'other')],
      },
    ],
  });
  const { bpFindByRole } = makeFinders(doc);

  it('restricts an indexed query to descendants of the scope container', () => {
    expect(bpFindByRole('button', '', false, 1, '.other')?.getAttribute('data-cmd')).toBe('b1');
    expect(bpFindByRole('button', '', false, 2, '.other')?.getAttribute('data-cmd')).toBe('b2');
    // Without scope the 4th button globally is the first of the second toolbar.
    expect(bpFindByRole('button', '', false, 4, null)?.getAttribute('data-cmd')).toBe('b1');
  });

  it('scopes with the first toolbar too', () => {
    expect(bpFindByRole('button', '', false, 3, '.editor')?.getAttribute('data-cmd')).toBe('a3');
  });

  it('returns null when the scope container does not exist', () => {
    expect(bpFindByRole('button', '', false, 1, '.nope')).toBeNull();
  });
});

describe('bpFindByRole — custom-element role inference', () => {
  // A web-component UI: custom tags with no explicit role attribute, matched by
  // generic affordance signals only (no tag names hard-coded in the finder).
  const doc = makeDocument({
    tag: 'html',
    children: [
      {
        tag: 'body',
        children: [
          { tag: 's-button', attrs: { tabindex: '0' }, text: 'More actions' },
          { tag: 's-link', attrs: { href: '/orders/GAL-1001' }, text: 'GAL-1001' },
          { tag: 's-clickable', cursor: 'pointer', text: 'Filter' },
          { tag: 's-onclick', attrs: { onclick: 'x()' }, text: 'Run' },
          // Non-interactive custom element: no affordance, so no inferred role.
          { tag: 's-text', text: 'Just a label' },
        ],
      },
    ],
  });
  const { bpFindByRole } = makeFinders(doc);

  it('infers button from a focusable (tabindex>=0) custom element', () => {
    expect(bpFindByRole('button', 'More actions', false, 0, null)?.tagName).toBe('S-BUTTON');
  });

  it('infers link from a custom element with href', () => {
    expect(bpFindByRole('link', 'GAL-', false, 0, null)?.tagName).toBe('S-LINK');
  });

  it('infers button from cursor:pointer', () => {
    expect(bpFindByRole('button', 'Filter', false, 0, null)?.tagName).toBe('S-CLICKABLE');
  });

  it('infers button from an onclick handler', () => {
    expect(bpFindByRole('button', 'Run', false, 0, null)?.tagName).toBe('S-ONCLICK');
  });

  it('does not infer a role for an affordance-free custom element', () => {
    expect(bpFindByRole('button', 'Just a label', false, 0, null)).toBeNull();
    expect(bpFindByRole('link', 'Just a label', false, 0, null)).toBeNull();
  });
});

describe('bpFindByRole — visibility is honored during indexing', () => {
  const doc = makeDocument({
    tag: 'html',
    children: [
      {
        tag: 'body',
        children: [
          {
            tag: 'div',
            attrs: { class: 'toolbar' },
            children: [
              { tag: 'button', attrs: { 'data-cmd': 'c1' }, visible: false },
              { tag: 'button', attrs: { 'data-cmd': 'c2' } },
              { tag: 'button', attrs: { 'data-cmd': 'c3' } },
            ],
          },
        ],
      },
    ],
  });
  const { bpFindByRole } = makeFinders(doc);

  it('skips hidden matches when includeHidden is false', () => {
    // Hidden c1 is skipped, so the 1st *visible* button is c2.
    expect(bpFindByRole('button', '', false, 1, null)?.getAttribute('data-cmd')).toBe('c2');
  });

  it('counts hidden matches when includeHidden is true', () => {
    expect(bpFindByRole('button', '', true, 1, null)?.getAttribute('data-cmd')).toBe('c1');
  });
});
