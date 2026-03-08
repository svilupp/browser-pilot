export interface ParsedTextSelector {
  query: string;
  exact: boolean;
}

export interface ParsedRoleSelector {
  role: string;
  name?: string;
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

export function parseTextSelector(selector: string): ParsedTextSelector | null {
  if (!selector.startsWith('text:')) return null;

  let raw = selector.slice(5).trim();
  let exact = false;

  if (raw.startsWith('=')) {
    exact = true;
    raw = raw.slice(1).trim();
  }

  const query = stripQuotes(raw);
  if (!query) return null;

  return { query, exact };
}

export function parseRoleSelector(selector: string): ParsedRoleSelector | null {
  if (!selector.startsWith('role:')) return null;

  const body = selector.slice(5);
  const separator = body.indexOf(':');
  const role = (separator === -1 ? body : body.slice(0, separator)).trim().toLowerCase();
  const name = separator === -1 ? undefined : stripQuotes(body.slice(separator + 1).trim());

  if (!role) return null;

  return { role, name: name || undefined };
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

function bpFindByText(query, exact, includeHidden) {
  var needle = bpNormalizeSpace(query).toLowerCase();
  if (!needle) return null;

  var best = null;
  var bestScore = -1;
  var elements = bpCollectElements(document);

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

function bpFindByRole(role, name, includeHidden) {
  var targetRole = bpNormalizeSpace(role).toLowerCase();
  if (!targetRole) return null;

  var nameNeedle = bpNormalizeSpace(name).toLowerCase();
  var best = null;
  var bestScore = -1;
  var elements = bpCollectElements(document);

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
      return bpFindByText(${JSON.stringify(text.query)}, ${text.exact}, ${includeHidden});
    })()`;
  }

  const role = parseRoleSelector(selector);
  if (role) {
    return `(() => {
      ${SPECIAL_SELECTOR_SCRIPT}
      return bpFindByRole(${JSON.stringify(role.role)}, ${JSON.stringify(role.name ?? '')}, ${includeHidden});
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
