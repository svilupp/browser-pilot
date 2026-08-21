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
    Fill input field. Always selects all text before inserting.

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

  {"action": "forms"}
    List form controls with labels, values, checked state, and options metadata.

  {"action": "text"}
    Extract visible page text.

  {"action": "screenshot"}
  {"action": "screenshot", "fullPage": true, "format": "jpeg", "quality": 80}
    Capture screenshot. Formats: png | jpeg | webp.

  {"action": "evaluate", "value": "document.title"}
    Run JavaScript and return result.

TAB MANAGEMENT
  {"action": "newTab"}
  {"action": "newTab", "url": "https://example.com"}
    Create a background tab and optionally navigate it. Returns { targetId }.
    Set "background": false to opt into foregrounding it.

  {"action": "closeTab"}
  {"action": "closeTab", "targetId": "TARGET_ID"}
    Close the current tab or a specific target by ID.

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

  Note: Cross-origin (out-of-process) iframes CAN be entered with switchFrame and
  support the fill subset (fill/type/focus/press/click/text/waitFor/evaluate). Limits:
  some in-frame actions hard-fail and need switchToMain first; a same-origin iframe
  nested inside a cross-origin frame (e.g. full Stripe Elements) is not yet supported;
  genuine cross-origin OOPIFs require Chrome site isolation (--site-per-process).

AUTHENTICATION (EPHEMERAL)
  {"action":"setCookie","cookie":{"name":"CF_Authorization","value":"...","domain":"example.com"}}
    Set a cookie on the live CDP session for this step only. Ephemeral: not
    persisted, lost on next attach/reattach. Useful for a one-off mid-flow
    swap (e.g. re-minting a Cloudflare Access JWT) without a full reconnect.

  {"action":"setHeaders","headers":{"CF-Access-Client-Id":"...","CF-Access-Client-Secret":"..."}}
    Replace the extra HTTP headers on the live CDP session for this step
    only. Same ephemeral caveats as setCookie; replaces the whole header set.

  For persisted, auto-reapplied Cloudflare Access auth that survives
  attach/reattach and daemon restarts, use 'bp env auth set-headers' /
  'set-cookie' / 'clear' instead (see 'bp env --help' and
  docs/proposals/cloudflare-access-auth.md).

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
    bp snapshot -s dev --format text   # Shows: button "Submit" ref:e4
    bp exec '{"action":"click","selector":"ref:e4"}'

  Refs are stable until navigation. Prefix with "ref:" to use.
  CLI caches refs per session+URL after snapshot, so they can be reused across exec calls.
  Example: {"action":"fill","selector":"ref:e23","value":"hello"}

TEXT / ROLE SELECTORS
  text:Continue              Match by accessible text/name (partial match)
  text:="Save Draft"         Exact text match
  role:button:Continue       Match by role and optional accessible name
  role:textbox:Email         Useful when stable CSS selectors are missing

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

ASSERTIONS
  {"action":"assertVisible","selector":"#success"}
  {"action":"assertExists","selector":"#mounted-node"}
  {"action":"assertText","expect":"Welcome back"}
  {"action":"assertUrl","expect":"/dashboard"}
  {"action":"assertValue","selector":"#email","expect":"user@example.com"}
    Assertion steps verify state inline inside a batch workflow.

MESSAGE INJECTION
  {"action":"emit","payload":{"type":"ping"}}
    Send a message on a WebSocket the page already owns.

  {"action":"emit","payload":{"type":"ping"},"match":"*realtime*"}
    Select the socket by URL. Required when several sockets are open - emit
    fails with the candidate list rather than guessing.

  {"action":"emit","payload":{"type":"ping"},
   "awaitReply":{"where":{"type":"pong"},"timeout":5000}}
    Wait for a correlated reply; the step fails if none arrives.

  Emits are at_most_once and "retry" is rejected: a re-sent frame duplicates a
  server-side action. A send on a closed socket is silently discarded by the
  browser, so delivery is confirmed against the frame leaving the wire.

EXECUTION RECORDING
  Replay with a screenshot trail:
    bp exec --record --file workflow.json
    bp exec --record '[{"action":"click","selector":"#checkout"}]'

  Artifacts:
    recording.json            Manifest for the latest recorded run
    screenshots/*.webp        One screenshot per captured step

  Sensitive inputs are redacted automatically when the field is marked as
  password/hidden or uses secret-style autocomplete hints such as
  current-password, one-time-code, or cc-number.

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
  bp snapshot -i  # Note the refs
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

DEBUGGING
  When actions fail, use these diagnostic tools:

  bp diagnose '#selector'               # Why can't this be found?
  bp diagnose '#selector' --json        # Machine-readable output
  bp snapshot --diff prev.json          # What changed on the page?
  bp snapshot --inspect                 # Visual ref labels on page
  bp list -s <id> --log-tail 10         # Recent command history

  Failure hints are included in error output when element not found.
  Use --json output for detailed hints with alternative selectors.
`;

export async function actionsCommand(): Promise<void> {
  console.log(ACTIONS_HELP);
}
