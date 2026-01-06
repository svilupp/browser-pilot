/**
 * Browser-side recorder script
 *
 * This script is injected into the browser page to capture user interactions.
 * It runs as an IIFE and sends events back to the CDP client via a binding.
 */

/**
 * The binding name used for communication between browser and CDP client.
 * This must match the name used in Runtime.addBinding().
 */
export const RECORDER_BINDING_NAME = '__recorder';

/**
 * The recorder script as a string constant.
 * This is injected into the browser via Runtime.evaluate and
 * Page.addScriptToEvaluateOnNewDocument.
 *
 * The script:
 * 1. Guards against multiple installations
 * 2. Captures click, dblclick, input, change, keydown, submit events
 * 3. Generates selector candidates (stable attrs, id, CSS path)
 * 4. Sends events to CDP client via window.__recorder binding
 * 5. Redacts password field values
 */
export const RECORDER_SCRIPT = `(function() {
  // Guard against multiple installations
  if (window.__recorderInstalled) return;
  window.__recorderInstalled = true;

  const BINDING_NAME = '__recorder';

  // Safe JSON stringify
  function safeJson(obj) {
    try {
      return JSON.stringify(obj);
    } catch (e) {
      return JSON.stringify({ error: 'unserializable' });
    }
  }

  // Send event to CDP client via binding
  function sendEvent(payload) {
    try {
      if (typeof window[BINDING_NAME] === 'function') {
        window[BINDING_NAME](safeJson(payload));
      }
    } catch (e) {
      // Binding not ready, ignore
    }
  }

  // CSS escape for identifiers
  function cssEscape(str) {
    return String(str).replace(/([\\[\\]#.:>+~=|^$*!"'(){}])/g, '\\\\$1');
  }

  // Check if selector is unique in document
  function isUnique(selector, root) {
    try {
      return (root || document).querySelectorAll(selector).length === 1;
    } catch (e) {
      return false;
    }
  }

  // Get stable attribute selector (data-testid, aria-label, name, etc.)
  function getStableAttrSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    const attrs = ['data-testid', 'data-test', 'data-qa', 'aria-label', 'name'];
    for (const attr of attrs) {
      const val = el.getAttribute(attr);
      if (val && val.length <= 200) {
        const escaped = val.replace(/"/g, '\\\\"');
        return '[' + attr + '="' + escaped + '"]';
      }
    }
    return null;
  }

  // Get ID selector
  function getIdSelector(el) {
    if (!el || !el.id || el.id.length > 100) return null;
    // Skip dynamic-looking IDs
    if (/^[0-9]|^:/.test(el.id)) return null;
    return '#' + cssEscape(el.id);
  }

  // Build CSS path for element
  function buildCssPath(el) {
    if (!el || el.nodeType !== 1) return null;
    const parts = [];
    let cur = el;

    for (let depth = 0; cur && cur !== document.body && depth < 8; depth++) {
      let part = cur.tagName.toLowerCase();

      // If ID exists and looks stable, use it and stop
      if (cur.id && !/^[0-9]|^:/.test(cur.id) && cur.id.length <= 50) {
        part = '#' + cssEscape(cur.id);
        parts.unshift(part);
        break;
      }

      // Add stable classes (skip dynamic ones)
      const classes = Array.from(cur.classList || [])
        .filter(c => c.length < 40 && !/^css-|^_|^[0-9]/.test(c))
        .slice(0, 2);
      if (classes.length) {
        part += '.' + classes.map(cssEscape).join('.');
      }

      // Add position if siblings have same tag
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (sameTag.length > 1) {
          const idx = sameTag.indexOf(cur) + 1;
          part += ':nth-of-type(' + idx + ')';
        }
      }

      parts.unshift(part);
      cur = cur.parentElement;
    }

    return parts.join(' > ');
  }

  // Generate selector candidates ordered by quality
  function getSelectorCandidates(el) {
    const candidates = [];

    // 1. Stable attributes (highest quality)
    const stableAttr = getStableAttrSelector(el);
    if (stableAttr) {
      candidates.push({ selector: stableAttr, quality: 'stable-attr' });
    }

    // 2. ID selector
    const idSel = getIdSelector(el);
    if (idSel) {
      candidates.push({ selector: idSel, quality: 'id' });
    }

    // 3. CSS path (fallback)
    const cssPath = buildCssPath(el);
    if (cssPath) {
      candidates.push({ selector: cssPath, quality: 'css-path' });
    }

    return candidates;
  }

  // Get element summary for debugging
  function getElementSummary(el) {
    if (!el || el.nodeType !== 1) return null;
    const text = (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      name: el.getAttribute('name') || null,
      type: el.getAttribute('type') || null,
      role: el.getAttribute('role') || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      testid: el.getAttribute('data-testid') || null,
      text: text || null
    };
  }

  // Get event target, handling shadow DOM via composedPath
  function getEventTarget(ev) {
    const path = ev.composedPath ? ev.composedPath() : null;
    if (path && path.length > 0) {
      for (const node of path) {
        if (node && node.nodeType === 1) return node;
      }
    }
    return ev.target && ev.target.nodeType === 1 ? ev.target : null;
  }

  // Find clickable ancestor (button, a, [role=button])
  function findClickableAncestor(el) {
    if (!el) return el;
    const clickable = el.closest('button, a, [role="button"], [role="link"]');
    return clickable || el;
  }

  // Check if element is a password input
  function isPasswordInput(el) {
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    if (tag !== 'input') return false;
    const type = (el.getAttribute('type') || '').toLowerCase();
    return type === 'password';
  }

  // Get input value, redacting passwords
  function getInputValue(el) {
    if (isPasswordInput(el)) return '[REDACTED]';
    if (el.value !== undefined) return el.value;
    if (el.isContentEditable) return el.textContent || '';
    return '';
  }

  // Current timestamp
  function now() { return Date.now(); }

  // Click handler
  window.addEventListener('click', function(ev) {
    const rawTarget = getEventTarget(ev);
    if (!rawTarget) return;

    // Bubble up to clickable ancestor for better selectors
    const el = findClickableAncestor(rawTarget);

    sendEvent({
      kind: 'click',
      timestamp: now(),
      url: location.href,
      element: getElementSummary(el),
      selectors: getSelectorCandidates(el),
      client: { x: ev.clientX, y: ev.clientY }
    });
  }, true);

  // Double click handler
  window.addEventListener('dblclick', function(ev) {
    const rawTarget = getEventTarget(ev);
    if (!rawTarget) return;

    const el = findClickableAncestor(rawTarget);

    sendEvent({
      kind: 'dblclick',
      timestamp: now(),
      url: location.href,
      element: getElementSummary(el),
      selectors: getSelectorCandidates(el),
      client: { x: ev.clientX, y: ev.clientY }
    });
  }, true);

  // Input handler (for text inputs, textareas, contenteditable)
  window.addEventListener('input', function(ev) {
    const el = getEventTarget(ev);
    if (!el) return;

    const tag = el.tagName.toLowerCase();
    const isTexty = tag === 'input' || tag === 'textarea' || el.isContentEditable;
    if (!isTexty) return;

    sendEvent({
      kind: 'input',
      timestamp: now(),
      url: location.href,
      element: getElementSummary(el),
      selectors: getSelectorCandidates(el),
      value: getInputValue(el)
    });
  }, true);

  // Change handler (for select, checkbox, radio)
  window.addEventListener('change', function(ev) {
    const el = getEventTarget(ev);
    if (!el) return;

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const isCheckable = type === 'checkbox' || type === 'radio';

    sendEvent({
      kind: 'change',
      timestamp: now(),
      url: location.href,
      element: getElementSummary(el),
      selectors: getSelectorCandidates(el),
      value: isCheckable ? undefined : getInputValue(el),
      checked: isCheckable ? el.checked : undefined
    });
  }, true);

  // Keydown handler (capture Enter for form submission)
  window.addEventListener('keydown', function(ev) {
    if (ev.key !== 'Enter') return;

    const el = getEventTarget(ev);

    sendEvent({
      kind: 'keydown',
      timestamp: now(),
      url: location.href,
      key: ev.key,
      element: el ? getElementSummary(el) : null,
      selectors: el ? getSelectorCandidates(el) : []
    });
  }, true);

  // Submit handler
  window.addEventListener('submit', function(ev) {
    const el = getEventTarget(ev);

    sendEvent({
      kind: 'submit',
      timestamp: now(),
      url: location.href,
      element: el ? getElementSummary(el) : null,
      selectors: el ? getSelectorCandidates(el) : []
    });
  }, true);
})();`;
