/**
 * Actions command - Show complete action reference
 */

const ACTIONS_HELP = `
bp actions - Complete action reference

All actions are JSON objects with "action" field. Use with 'bp exec'.

NAVIGATION
  {"action": "goto", "url": "https://..."}
    Navigate to URL.

  {"action": "wait", "waitFor": "navigation"}
    Wait for page navigation to complete.

  {"action": "wait", "waitFor": "networkIdle"}
    Wait for network activity to settle.

  {"action": "wait", "timeout": 2000}
    Simple delay in milliseconds.

INTERACTION
  {"action": "click", "selector": "#button"}
  {"action": "click", "selector": ["#primary", ".fallback"]}
    Click element. Multi-selector tries each until success.

  {"action": "fill", "selector": "#input", "value": "text"}
  {"action": "fill", "selector": "#input", "value": "text", "clear": false}
    Fill input field. Clears first by default.

  {"action": "type", "selector": "#input", "value": "text", "delay": 50}
    Type character-by-character (for autocomplete).

  {"action": "select", "selector": "#dropdown", "value": "option-value"}
    Select native <select> option by value.

  {"action": "select", "trigger": ".dropdown", "option": ".item", "value": "Label", "match": "text"}
    Custom dropdown: click trigger, then click matching option.

  {"action": "check", "selector": "#checkbox"}
  {"action": "uncheck", "selector": "#checkbox"}
    Check/uncheck checkbox or radio.

  {"action": "submit", "selector": "form"}
  {"action": "submit", "selector": "#btn", "method": "click"}
    Submit form. Methods: enter | click | enter+click (default).

  {"action": "press", "key": "Enter"}
  {"action": "press", "key": "Escape"}
  {"action": "press", "key": "Tab"}
    Press key. Common keys: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right.

  {"action": "focus", "selector": "#input"}
  {"action": "hover", "selector": ".menu-item"}
    Focus or hover element.

  {"action": "scroll", "selector": "#footer"}
  {"action": "scroll", "x": 0, "y": 1000}
  {"action": "scroll", "direction": "down", "amount": 500}
    Scroll to element, coordinates, or by direction (up/down/left/right).

WAITING
  {"action": "wait", "selector": ".loaded", "waitFor": "visible"}
  {"action": "wait", "selector": ".spinner", "waitFor": "hidden"}
  {"action": "wait", "selector": "#element", "waitFor": "attached"}
  {"action": "wait", "selector": "#removed", "waitFor": "detached"}
    Wait for element state. States: visible | hidden | attached | detached.

  {"action": "wait", "timeout": 1000}
    Simple delay (milliseconds).

CONTENT EXTRACTION
  {"action": "snapshot"}
    Get accessibility tree (best for understanding page structure).

  {"action": "screenshot"}
  {"action": "screenshot", "fullPage": true, "format": "jpeg", "quality": 80}
    Capture screenshot. Formats: png | jpeg | webp.

  {"action": "evaluate", "value": "document.title"}
    Run JavaScript and return result.

IFRAME NAVIGATION
  {"action": "switchFrame", "selector": "iframe#checkout"}
    Switch context to an iframe. All subsequent actions target the iframe content.

  {"action": "switchToMain"}
    Switch back to the main document from an iframe.

  Example iframe workflow:
    [
      {"action": "switchFrame", "selector": "iframe#payment"},
      {"action": "fill", "selector": "#card-number", "value": "4242424242424242"},
      {"action": "fill", "selector": "#expiry", "value": "12/25"},
      {"action": "switchToMain"},
      {"action": "click", "selector": "#submit-order"}
    ]

  Note: Cross-origin iframes cannot be accessed due to browser security.

DIALOG HANDLING
  Use --dialog flag: bp exec --dialog accept '[...]'
  Modes: accept (click OK), dismiss (click Cancel)

  WARNING: Without --dialog flag, native dialogs (alert/confirm/prompt) will
  block ALL automation until manual intervention.

COMMON OPTIONS (all actions)
  "timeout": 5000        Override default timeout (ms)
  "optional": true       Don't fail if element not found

REF SELECTORS (from snapshot)
  After taking a snapshot, use refs directly:
    bp snapshot -s dev --format text   # Shows: button "Submit" [ref=e4]
    bp exec '{"action":"click","selector":"ref:e4"}'

  Refs are stable until navigation. Prefix with "ref:" to use.
  CLI caches refs per session+URL after snapshot, so they can be reused across exec calls.
  Example: {"action":"fill","selector":"ref:e23","value":"hello"}

MULTI-SELECTOR PATTERN
  All selectors accept arrays: ["#id", ".class", "[aria-label=X]"]
  Tries each in order until one succeeds.
  Combine refs with CSS fallbacks: ["ref:e4", "#submit", ".btn"]

SELECTOR PRIORITY (Most to Least Reliable)
  1. ref:eN               - From snapshot, most reliable for AI agents
  2. [data-testid="..."]  - Explicit test hooks
  3. #id                  - Reliable if IDs are stable
  4. [aria-label="..."]   - Good for buttons without testids
  5. Multi-selector array - Fallback pattern for compatibility

SHADOW DOM
  Selectors automatically pierce shadow DOM (1-2 levels). No special syntax needed.
  For deeper nesting (3+ levels), use refs from snapshot - they work at any depth.

:has-text() SELECTOR
  Matches elements containing text content.
  Does NOT match aria-label - use [aria-label="..."] instead.
  Example: button:has-text("Submit") matches <button>Submit</button>
           button[aria-label="Submit"] matches <button aria-label="Submit">X</button>

EXAMPLES
  # Login flow
  bp exec '[
    {"action":"goto","url":"https://app.example.com/login"},
    {"action":"fill","selector":"#email","value":"user@example.com"},
    {"action":"fill","selector":"#password","value":"secret"},
    {"action":"submit","selector":"form"},
    {"action":"wait","waitFor":"navigation"},
    {"action":"snapshot"}
  ]'

  # Handle cookie banner then extract content
  bp exec '[
    {"action":"goto","url":"https://example.com"},
    {"action":"click","selector":"#accept-cookies","optional":true,"timeout":3000},
    {"action":"snapshot"}
  ]'

  # Use ref from snapshot
  bp snapshot --format text  # Note the refs
  bp exec '{"action":"click","selector":"ref:e4"}'

  # Scroll and wait
  bp exec '[
    {"action":"scroll","direction":"down","amount":1000},
    {"action":"wait","timeout":500},
    {"action":"scroll","direction":"down","amount":1000}
  ]'

  # Handle dialogs
  bp exec --dialog accept '[
    {"action":"click","selector":"#delete-btn"},
    {"action":"wait","selector":"#success-message","waitFor":"visible"}
  ]'
`;

export async function actionsCommand(): Promise<void> {
  console.log(ACTIONS_HELP);
}
