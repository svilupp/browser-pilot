export interface ParsedTextSelector {
  query: string;
  exact: boolean;
  /**
   * 1-based positional index into the DOM-ordered list of matches, when the
   * selector carried a `[N]` suffix (e.g. `text:"Add"[2]`). `undefined` means
   * "single best match" (legacy behaviour).
   */
  index?: number;
  /**
   * CSS selector for a container to restrict the search to, when the selector
   * carried a scope prefix (`within(<css>) …` or `<css> >> …`). `undefined`
   * means "search the whole document".
   */
  scope?: string;
}

export interface ParsedRoleSelector {
  role: string;
  name?: string;
  /**
   * 1-based positional index into the DOM-ordered list of matches, when the
   * selector carried a `[N]` suffix (e.g. `role:button[2]`). `undefined` means
   * "single best match" (legacy behaviour).
   */
  index?: number;
  /**
   * CSS selector for a container to restrict the search to, when the selector
   * carried a scope prefix (`within(<css>) …` or `<css> >> …`). `undefined`
   * means "search the whole document".
   */
  scope?: string;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Split an optional container scope off the front of a special selector.
 *
 * Two equivalent, order-independent forms are recognised:
 *   - `within(<containerSelector>) <inner>`  e.g. `within(.toolbar) role:button[2]`
 *   - `<containerSelector> >> <inner>`        e.g. `.toolbar >> role:button[2]`
 *
 * The container selector is an arbitrary (shadow-piercing) CSS selector; the
 * inner is the remaining `text:`/`role:` special selector. When no scope prefix
 * is present the whole string is returned as `inner` with no `scope`.
 *
 * The `>>` split only takes effect when both sides are non-empty; this keeps a
 * plain (albeit deprecated) CSS `a >> b` from being misparsed here — if the
 * inner is not a recognised special selector the caller falls back to treating
 * the ORIGINAL string as plain CSS.
 */
function isSpecialInner(inner: string): boolean {
  return inner.startsWith('role:') || inner.startsWith('text:');
}

function parseScopePrefix(selector: string): { scope?: string; inner: string } {
  const s = selector.trim();

  const withinMatch = /^within\(\s*([\s\S]+?)\s*\)\s+([\s\S]+)$/.exec(s);
  if (withinMatch?.[1] && withinMatch[2]) {
    const inner = withinMatch[2].trim();
    if (isSpecialInner(inner)) {
      return { scope: stripQuotes(withinMatch[1].trim()), inner };
    }
  }

  // `<containerSelector> >> <inner>`. Only treat `>>` as a scope separator when
  // the right-hand side is itself a special selector — this keeps a literal
  // `text:">>"` query and plain (deprecated) CSS `a >> b` from being misparsed.
  const idx = s.indexOf('>>');
  if (idx > 0) {
    const left = s.slice(0, idx).trim();
    const right = s.slice(idx + 2).trim();
    if (left && isSpecialInner(right)) return { scope: stripQuotes(left), inner: right };
  }

  return { inner: s };
}

/**
 * Pull a trailing 1-based `[N]` positional index off a selector body, if any.
 * A bracketed index only counts when it is the very last token (so a bracketed
 * value inside a quoted name — e.g. `role:button:"foo[2]"` — is left intact).
 */
function extractTrailingIndex(body: string): { body: string; index?: number } {
  const match = /\[(\d+)\]\s*$/.exec(body);
  if (!match) return { body };
  const index = Number.parseInt(match[1] as string, 10);
  return { body: body.slice(0, match.index).trim(), index };
}

export function parseTextSelector(selector: string): ParsedTextSelector | null {
  const { scope, inner } = parseScopePrefix(selector);
  if (!inner.startsWith('text:')) return null;

  let raw = inner.slice(5).trim();
  let exact = false;

  if (raw.startsWith('=')) {
    exact = true;
    raw = raw.slice(1).trim();
  }

  const { body, index } = extractTrailingIndex(raw);
  raw = body;

  const query = stripQuotes(raw);
  if (!query) return null;

  return { query, exact, index, scope };
}

/**
 * Pull a trailing `[name="..."]` bracket off a role selector body, if any.
 * Agents naturally write `role:button[name="More actions"]` (CSS-attribute
 * style) as an alias for `role:button:"More actions"`, so accept both. The
 * bracket value may be double-quoted, single-quoted, or bare, and only the
 * `name` attribute is recognised — any other bracket is left untouched so the
 * caller can fall back to plain CSS.
 */
function extractTrailingNameBracket(body: string): { body: string; name?: string } {
  const match = /\[\s*name\s*=\s*("([^"]*)"|'([^']*)'|([^\]]*?))\s*\]\s*$/.exec(body);
  if (!match) return { body };
  const name = match[2] ?? match[3] ?? match[4] ?? '';
  return { body: body.slice(0, match.index).trim(), name };
}

export function parseRoleSelector(selector: string): ParsedRoleSelector | null {
  const { scope, inner } = parseScopePrefix(selector);
  if (!inner.startsWith('role:')) return null;

  const { body: withoutIndex, index } = extractTrailingIndex(inner.slice(5));
  const { body: withoutBracket, name: bracketName } = extractTrailingNameBracket(withoutIndex);
  const separator = withoutBracket.indexOf(':');
  const role = (separator === -1 ? withoutBracket : withoutBracket.slice(0, separator))
    .trim()
    .toLowerCase();
  const colonName =
    separator === -1 ? undefined : stripQuotes(withoutBracket.slice(separator + 1).trim());
  const name = bracketName !== undefined ? bracketName : colonName;

  if (!role) return null;

  return { role, name: name || undefined, index, scope };
}

export const SPECIAL_SELECTOR_SCRIPT = `
function bpNormalizeSpace(value) {
  return String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
}

function bpCollectElements(root) {
  var elements = [];

  function visit(node) {
    if (!node || typeof node.querySelectorAll !== 'function') return;
    var matches = node.querySelectorAll('*');
    for (var i = 0; i < matches.length; i++) {
      var el = matches[i];
      elements.push(el);
      if (el.shadowRoot) {
        visit(el.shadowRoot);
      }
    }
  }

  if (root && root.documentElement) {
    elements.push(root.documentElement);
  }

  visit(root);
  return elements;
}

// Shadow-piercing querySelector used to resolve a scope container. Mirrors the
// deep-query behaviour used elsewhere: try the light DOM first, then descend
// into every shadow root in document order and return the first match.
function bpDeepQuerySelector(root, selector) {
  if (!root || !selector) return null;
  var direct = null;
  try {
    direct = root.querySelector(selector);
  } catch (e) {
    return null;
  }
  if (direct) return direct;
  var hosts = root.querySelectorAll('*');
  for (var i = 0; i < hosts.length; i++) {
    if (hosts[i].shadowRoot) {
      var found = bpDeepQuerySelector(hosts[i].shadowRoot, selector);
      if (found) return found;
    }
  }
  return null;
}

// Collect the descendants of a container in flattened DOM order, piercing any
// shadow roots. Deduplicated so a positional index is always stable. The
// container itself is NOT included (scope = "descendants of the container").
function bpCollectDescendants(container) {
  var elements = [];
  var seen = new Set();

  function visit(node) {
    if (!node || typeof node.querySelectorAll !== 'function') return;
    var matches = node.querySelectorAll('*');
    for (var i = 0; i < matches.length; i++) {
      var el = matches[i];
      if (seen.has(el)) continue;
      seen.add(el);
      elements.push(el);
      if (el.shadowRoot) {
        visit(el.shadowRoot);
      }
    }
  }

  visit(container);
  if (container && container.shadowRoot) {
    visit(container.shadowRoot);
  }
  return elements;
}

// Resolve the candidate element set for a query: either every element in the
// document (legacy) or, when a scope selector is given, only the descendants of
// the (shadow-piercing) container. Returns null when a requested scope
// container does not exist, so the query resolves to "no match".
function bpCandidateElements(scopeSelector) {
  if (scopeSelector) {
    var container = bpDeepQuerySelector(document, scopeSelector);
    if (!container) return null;
    return bpCollectDescendants(container);
  }
  return bpCollectElements(document);
}

function bpIsVisible(el) {
  if (!el) return false;
  var style = getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (parseFloat(style.opacity || '1') === 0) return false;
  var rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function bpInferRole(el) {
  if (!el || !el.tagName) return '';

  var explicitRole = bpNormalizeSpace(el.getAttribute && el.getAttribute('role'));
  if (explicitRole) return explicitRole.toLowerCase();

  var tag = el.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a' && el.hasAttribute('href')) return 'link';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
  if (tag === 'option') return 'option';
  if (tag === 'summary') return 'button';

  if (tag === 'input') {
    var type = (el.type || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'search') return 'searchbox';
    if (type === 'number') return 'spinbutton';
    if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') {
      return 'button';
    }
    return 'textbox';
  }

  // Custom elements (tag contains a hyphen) have no native role mapping, but
  // component libraries (web components) frequently render interactive controls
  // as custom tags with no explicit role attribute. Infer a role from generic,
  // affordance-based signals only — never from specific tag names — so this
  // stays library-agnostic. Gated to custom elements, which are rare relative to
  // the total node count, so the getComputedStyle fallback stays cheap overall.
  if (tag.indexOf('-') !== -1) {
    var getAttr = el.getAttribute ? el.getAttribute.bind(el) : function () { return null; };
    if ((el.hasAttribute && el.hasAttribute('href')) || getAttr('href')) return 'link';

    var tabindex = getAttr('tabindex');
    if (tabindex != null && !isNaN(parseInt(tabindex, 10)) && parseInt(tabindex, 10) >= 0) {
      return 'button';
    }
    if (el.hasAttribute && el.hasAttribute('onclick')) return 'button';

    // A native interactive control inside the shadow root is a strong signal
    // that the host is meant to be actioned as a button (shallow check only).
    if (el.shadowRoot && typeof el.shadowRoot.querySelector === 'function') {
      try {
        if (el.shadowRoot.querySelector('button, a[href], [role="button"], input, select, textarea')) {
          return 'button';
        }
      } catch (e) {}
    }

    // cursor:pointer is the most reliable generic "this is clickable" hint. It
    // needs getComputedStyle, so it runs last and only for custom elements.
    try {
      var cs = getComputedStyle(el);
      if (cs && cs.cursor === 'pointer') return 'button';
    } catch (e) {}
  }

  return '';
}

function bpTextFromIdRefs(refs) {
  if (!refs) return '';
  var ids = refs.split(/\\s+/).filter(Boolean);
  var parts = [];
  for (var i = 0; i < ids.length; i++) {
    var node = document.getElementById(ids[i]);
    if (!node) continue;
    var text = bpNormalizeSpace(node.innerText || node.textContent || '');
    if (text) parts.push(text);
  }
  return bpNormalizeSpace(parts.join(' '));
}

function bpAccessibleName(el) {
  if (!el) return '';

  var labelledBy = bpTextFromIdRefs(el.getAttribute && el.getAttribute('aria-labelledby'));
  if (labelledBy) return labelledBy;

  var ariaLabel = bpNormalizeSpace(el.getAttribute && el.getAttribute('aria-label'));
  if (ariaLabel) return ariaLabel;

  if (el.labels && el.labels.length) {
    var labels = [];
    for (var i = 0; i < el.labels.length; i++) {
      var labelText = bpNormalizeSpace(el.labels[i].innerText || el.labels[i].textContent || '');
      if (labelText) labels.push(labelText);
    }
    if (labels.length) return bpNormalizeSpace(labels.join(' '));
  }

  if (el.id) {
    var fallbackLabel = document.querySelector('label[for="' + el.id.replace(/"/g, '\\\\"') + '"]');
    if (fallbackLabel) {
      var fallbackText = bpNormalizeSpace(
        fallbackLabel.innerText || fallbackLabel.textContent || ''
      );
      if (fallbackText) return fallbackText;
    }
  }

  var type = (el.type || '').toLowerCase();
  if (
    el.tagName === 'INPUT' &&
    (type === 'submit' || type === 'button' || type === 'reset' || type === 'image')
  ) {
    var inputValue = bpNormalizeSpace(el.value || el.getAttribute('value'));
    if (inputValue) return inputValue;
  }

  var alt = bpNormalizeSpace(el.getAttribute && el.getAttribute('alt'));
  if (alt) return alt;

  var text = bpNormalizeSpace(el.innerText || el.textContent || '');
  if (text) return text;

  var placeholder = bpNormalizeSpace(el.getAttribute && el.getAttribute('placeholder'));
  if (placeholder) return placeholder;

  var title = bpNormalizeSpace(el.getAttribute && el.getAttribute('title'));
  if (title) return title;

  var value = bpNormalizeSpace(el.value);
  if (value) return value;

  return bpNormalizeSpace(el.name || el.id || '');
}

function bpIsInteractive(role, el) {
  if (
    role === 'button' ||
    role === 'link' ||
    role === 'textbox' ||
    role === 'checkbox' ||
    role === 'radio' ||
    role === 'combobox' ||
    role === 'listbox' ||
    role === 'option' ||
    role === 'searchbox' ||
    role === 'spinbutton' ||
    role === 'switch' ||
    role === 'tab'
  ) {
    return true;
  }

  if (!el || !el.tagName) return false;
  var tag = el.tagName.toLowerCase();
  return tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea';
}

function bpFindByText(query, exact, includeHidden, index, scopeSelector) {
  var needle = bpNormalizeSpace(query).toLowerCase();
  if (!needle) return null;

  var elements = bpCandidateElements(scopeSelector);
  if (!elements) return null;

  // Positional query (1-based): return the Nth match in DOM order, no scoring.
  if (index) {
    var seen = 0;
    for (var k = 0; k < elements.length; k++) {
      var candidate = elements[k];
      if (!includeHidden && !bpIsVisible(candidate)) continue;
      var candidateText = bpAccessibleName(candidate);
      if (!candidateText) continue;
      var candidateHay = candidateText.toLowerCase();
      var candidateMatched = exact ? candidateHay === needle : candidateHay.includes(needle);
      if (!candidateMatched) continue;
      seen++;
      if (seen === index) return candidate;
    }
    return null;
  }

  var best = null;
  var bestScore = -1;

  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    if (!includeHidden && !bpIsVisible(el)) continue;

    var text = bpAccessibleName(el);
    if (!text) continue;

    var haystack = text.toLowerCase();
    var matched = exact ? haystack === needle : haystack.includes(needle);
    if (!matched) continue;

    var role = bpInferRole(el);
    var score = 0;
    if (bpIsInteractive(role, el)) score += 100;
    if (haystack === needle) score += 50;
    if (role === 'button' || role === 'link') score += 10;

    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }

  return best;
}

function bpFindByRole(role, name, includeHidden, index, scopeSelector) {
  var targetRole = bpNormalizeSpace(role).toLowerCase();
  if (!targetRole) return null;

  var nameNeedle = bpNormalizeSpace(name).toLowerCase();

  var elements = bpCandidateElements(scopeSelector);
  if (!elements) return null;

  // Positional query (1-based): return the Nth match in DOM order, no scoring.
  if (index) {
    var seen = 0;
    for (var k = 0; k < elements.length; k++) {
      var candidate = elements[k];
      if (!includeHidden && !bpIsVisible(candidate)) continue;
      if (bpInferRole(candidate) !== targetRole) continue;
      if (nameNeedle) {
        var candidateName = bpAccessibleName(candidate).toLowerCase();
        if (!candidateName.includes(nameNeedle)) continue;
      }
      seen++;
      if (seen === index) return candidate;
    }
    return null;
  }

  var best = null;
  var bestScore = -1;

  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    if (!includeHidden && !bpIsVisible(el)) continue;

    var actualRole = bpInferRole(el);
    if (actualRole !== targetRole) continue;

    var accessibleName = bpAccessibleName(el);
    if (nameNeedle) {
      var loweredName = accessibleName.toLowerCase();
      if (!loweredName.includes(nameNeedle)) continue;
    }

    var score = 0;
    if (accessibleName) score += 10;
    if (nameNeedle && accessibleName.toLowerCase() === nameNeedle) score += 20;

    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }

  return best;
}
`;

export function buildSpecialSelectorLookupExpression(
  selector: string,
  options: { includeHidden?: boolean } = {}
): string | null {
  const includeHidden = options.includeHidden === true;
  const text = parseTextSelector(selector);
  if (text) {
    return `(() => {
      ${SPECIAL_SELECTOR_SCRIPT}
      return bpFindByText(${JSON.stringify(text.query)}, ${text.exact}, ${includeHidden}, ${text.index ?? 0}, ${JSON.stringify(text.scope ?? null)});
    })()`;
  }

  const role = parseRoleSelector(selector);
  if (role) {
    return `(() => {
      ${SPECIAL_SELECTOR_SCRIPT}
      return bpFindByRole(${JSON.stringify(role.role)}, ${JSON.stringify(role.name ?? '')}, ${includeHidden}, ${role.index ?? 0}, ${JSON.stringify(role.scope ?? null)});
    })()`;
  }

  return null;
}

export function buildSpecialSelectorPredicateExpression(
  selector: string,
  options: { includeHidden?: boolean } = {}
): string | null {
  const lookup = buildSpecialSelectorLookupExpression(selector, options);
  if (!lookup) return null;
  return `(() => !!(${lookup}))()`;
}
