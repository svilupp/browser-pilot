---
name: browser-pilot
description: Browser automation skill using browser-pilot CLI. Use this when you need to control a web browser - navigate to URLs, fill forms, click buttons, extract page content, or take screenshots. Works with local Chrome, BrowserBase, and Browserless providers.
compatibility: Requires browser-pilot CLI (bp). Install with `bun add browser-pilot` or `npm install browser-pilot`. For local browser, Chrome must be running with --remote-debugging-port=9222.
---

# Browser Automation with browser-pilot

Control web browsers via the `bp` CLI. Execute actions, extract content, and automate workflows.

## Recommended Workflow: Snapshot → Ref

**Always use refs from snapshots for reliable element targeting.** This is the most reliable approach, especially for Shadow DOM and complex UIs.

```bash
# 1. Navigate and take snapshot
bp exec '{"action":"goto","url":"https://example.com"}'
bp snapshot --format text

# Output shows refs:
#   button "Submit" [ref=e4]
#   textbox "Email" [ref=e5]
#   checkbox "Remember me" [ref=e8]

# 2. Use refs to interact (most reliable)
bp exec '{"action":"fill","selector":"ref:e5","value":"user@example.com"}'
bp exec '{"action":"click","selector":"ref:e4"}'

# 3. After navigation, take new snapshot (refs reset)
bp snapshot --format text
```

**Why refs?**
- Work even inside Shadow DOM (any depth)
- No CSS selector guessing
- Stable within page session
- Direct mapping: what you see → what you click

## Quick Reference

```bash
# Connect to browser
bp connect --provider generic              # Local Chrome (auto-discovers)
bp connect --provider browserbase --name s # Cloud browser

# THE WORKFLOW: snapshot → ref → action → snapshot
bp exec '{"action":"goto","url":"https://example.com"}'
bp snapshot --format text                  # See elements with [ref=eN]
bp exec '{"action":"click","selector":"ref:e4"}'
bp snapshot --format text                  # Refresh after changes

# Handle native dialogs (CRITICAL - blocks automation without this)
bp exec --dialog accept '{"action":"click","selector":"#delete-btn"}'

# Session management
bp list                                    # List sessions
bp close -s session-name                   # Close session
bp actions                                 # Complete action reference
```

## Step-by-Step Workflow

### 1. Connect to a Browser

**Local Chrome** (start Chrome with `--remote-debugging-port=9222` first):
```bash
bp connect --provider generic --name dev
```

**BrowserBase** (cloud browser):
```bash
bp connect --provider browserbase --name prod --api-key $BROWSERBASE_API_KEY
```

### 2. Execute Actions

Single action:
```bash
bp exec -s dev '{"action":"goto","url":"https://example.com"}'
```

Multiple actions (batch):
```bash
bp exec -s dev '[
  {"action":"goto","url":"https://example.com/login"},
  {"action":"fill","selector":"#email","value":"user@example.com"},
  {"action":"fill","selector":"#password","value":"secret"},
  {"action":"submit","selector":"form"},
  {"action":"wait","waitFor":"navigation"},
  {"action":"snapshot"}
]' --output json
```

### 3. Read Page State

```bash
# Text representation of accessibility tree
bp snapshot -s dev --format text

# Interactive elements only (buttons, links, inputs)
bp snapshot -s dev --format interactive --output json

# Extract specific text
bp text -s dev --selector ".main-content"
```

### 4. Close When Done

```bash
bp close -s dev
```

## Action DSL Reference

### Navigation
```json
{"action": "goto", "url": "https://example.com"}
```

### Click
```json
{"action": "click", "selector": "#button"}
{"action": "click", "selector": ["#primary", ".fallback"]}
{"action": "click", "selector": "#maybe", "optional": true}
```

### Fill (clears first)
```json
{"action": "fill", "selector": "#email", "value": "user@example.com"}
{"action": "fill", "selector": "#input", "value": "append", "clear": false}
```

### Type (character by character, for autocomplete)
```json
{"action": "type", "selector": "#search", "value": "query", "delay": 50}
```

### Select
```json
{"action": "select", "selector": "#country", "value": "US"}
```

Custom dropdown:
```json
{"action": "select", "trigger": ".dropdown", "option": ".item", "value": "Option", "match": "text"}
```

### Checkbox
```json
{"action": "check", "selector": "#agree"}
{"action": "uncheck", "selector": "#newsletter"}
```

### Submit
```json
{"action": "submit", "selector": "form"}
{"action": "submit", "selector": "#btn", "method": "click"}
```

### Press Key
```json
{"action": "press", "key": "Enter"}
{"action": "press", "key": "Escape"}
{"action": "press", "key": "Tab"}
```

### Focus/Hover
```json
{"action": "focus", "selector": "#input"}
{"action": "hover", "selector": ".menu-item"}
```

### Scroll
```json
{"action": "scroll", "selector": "#footer"}
{"action": "scroll", "x": 0, "y": 1000}
{"action": "scroll", "direction": "down", "amount": 500}
{"action": "scroll", "direction": "up"}
```
Direction can be: up, down, left, right. Default amount is 500px.

### Wait
```json
{"action": "wait", "selector": ".loaded", "waitFor": "visible"}
{"action": "wait", "selector": ".spinner", "waitFor": "hidden"}
{"action": "wait", "waitFor": "navigation"}
{"action": "wait", "waitFor": "networkIdle"}
{"action": "wait", "timeout": 2000}
```
The last form is a simple delay in milliseconds.

### Extract Content
```json
{"action": "snapshot"}
{"action": "screenshot"}
{"action": "screenshot", "fullPage": true, "format": "jpeg", "quality": 80}
{"action": "evaluate", "value": "document.title"}
```

### Iframe Navigation
```json
{"action": "switchFrame", "selector": "iframe#checkout"}
{"action": "switchToMain"}
```

Example workflow for iframes:
```json
[
  {"action": "switchFrame", "selector": "iframe#payment"},
  {"action": "fill", "selector": "#card-number", "value": "4242424242424242"},
  {"action": "switchToMain"},
  {"action": "click", "selector": "#submit-order"}
]
```

Note: Cross-origin iframes cannot be accessed due to browser security.

## Ref-Based Selectors

**This is the recommended way to target elements.** Refs work even when CSS selectors fail (Shadow DOM, dynamic IDs, complex nesting).

```bash
# Take snapshot - every interactive element gets a ref
bp snapshot --format text
# Output:
#   button "Submit" [ref=e4]
#   textbox "Email" [ref=e5]
#   textbox "Deep input" [ref=e62]  ← Even inside Shadow DOM!

# Use refs to interact
bp exec '{"action":"click","selector":"ref:e4"}'
bp exec '{"action":"fill","selector":"ref:e5","value":"test@example.com"}'
bp exec '{"action":"fill","selector":"ref:e62","value":"works in Shadow DOM"}'
```

**Rules:**
- Take snapshot first, then use refs
- Refs reset on page navigation → take new snapshot after `goto` or form submit
- Use `ref:` prefix: `"selector": "ref:e4"`
- Combine with CSS fallbacks: `["ref:e4", "#submit", "button[type=submit]"]`

**When to use refs vs CSS selectors:**
| Situation | Use |
|-----------|-----|
| Shadow DOM elements | `ref:eN` (CSS often fails) |
| Dynamic/generated IDs | `ref:eN` |
| Stable test hooks exist | `[data-testid="..."]` or `ref:eN` |
| Cookie banners (unknown structure) | Multi-selector array |

## Dialog Handling

⚠️ **CRITICAL:** Native browser dialogs (`alert()`, `confirm()`, `prompt()`) **block ALL automation** until handled. Without the `--dialog` flag, your session will hang indefinitely.

```bash
# ALWAYS use --dialog when actions might trigger native dialogs
bp exec --dialog accept '[{"action":"click","selector":"#delete-btn"}]'

# Accept = click OK, Dismiss = click Cancel
bp exec --dialog dismiss '[{"action":"click","selector":"#cancel-action"}]'
```

**When to use `--dialog`:**
- Delete buttons that might show `confirm("Are you sure?")`
- Actions that trigger `alert()` notifications
- Any form that uses `prompt()` for input

**Custom modals (role="dialog") work fine without this flag** - only native JS dialogs require `--dialog`.

## Multi-Selector Pattern

Every selector can be an array. Tries each until one succeeds:
```json
{"action": "click", "selector": ["#submit", "button[type=submit]", ".submit-btn"]}
```

Use this for robust automation when selectors might vary.

## Optional Actions

Set `"optional": true` to skip gracefully if element not found:
```json
{"action": "click", "selector": "#cookie-banner", "optional": true, "timeout": 3000}
```

## Output Formats

```bash
bp exec '...' --output json    # Structured JSON
bp exec '...' --output pretty  # Human-readable (default)
```

JSON output structure:
```json
{
  "success": true,
  "totalDurationMs": 1500,
  "steps": [
    {"action": "goto", "success": true, "durationMs": 1200},
    {"action": "click", "success": true, "durationMs": 50, "selectorUsed": "#submit"},
    {"action": "snapshot", "success": true, "result": "..."}
  ]
}
```

## Common Patterns

### Login Flow (Using Refs)
```bash
# Navigate and get refs
bp exec '{"action":"goto","url":"https://app.example.com/login"}'
bp snapshot --format text
# Output: textbox "Email" [ref=e3], textbox "Password" [ref=e5], button "Login" [ref=e7]

# Fill using refs (most reliable)
bp exec '[
  {"action":"fill","selector":"ref:e3","value":"user@example.com"},
  {"action":"fill","selector":"ref:e5","value":"password"},
  {"action":"click","selector":"ref:e7"},
  {"action":"wait","waitFor":"navigation"},
  {"action":"snapshot"}
]' --output json
```

### Search and Extract Results
```bash
bp exec '[
  {"action":"goto","url":"https://search.example.com"},
  {"action":"snapshot"}
]'
# Get refs from snapshot, then:
bp exec '[
  {"action":"fill","selector":"ref:e4","value":"browser automation"},
  {"action":"click","selector":"ref:e5"},
  {"action":"wait","selector":"[data-testid=\"results\"]","waitFor":"visible"},
  {"action":"snapshot"}
]' --output json
```

### Handle Cookie Consent
```bash
bp exec '[
  {"action":"goto","url":"https://example.com"},
  {"action":"click","selector":["[data-testid=\"cookie-accept\"]",".cookie-accept","#accept-cookies"],"optional":true,"timeout":3000},
  {"action":"snapshot"}
]'
```

### Form with Custom Dropdown
```bash
bp exec '[
  {"action":"goto","url":"https://form.example.com"},
  {"action":"snapshot"}
]'
# Use refs from snapshot:
bp exec '[
  {"action":"fill","selector":"ref:e3","value":"John Doe"},
  {"action":"select","trigger":"ref:e5","option":".dropdown-item","value":"United States","match":"text"},
  {"action":"check","selector":"ref:e8"},
  {"action":"click","selector":"ref:e10"}
]'
```

### Delete with Confirmation Dialog
```bash
# CRITICAL: Use --dialog flag for native confirm() dialogs
bp exec --dialog accept '[
  {"action":"click","selector":"ref:e15"},
  {"action":"wait","selector":"[data-testid=\"success\"]","waitFor":"visible"}
]'
```

## Error Handling

Batch with `onFail: stop` (default) stops on first failure.

Check result for failures:
```bash
result=$(bp exec -o json '[...]')
success=$(echo "$result" | jq '.success')
if [ "$success" = "false" ]; then
  echo "Failed at step: $(echo "$result" | jq '.stoppedAtIndex')"
fi
```

## Shadow DOM

**Use refs for Shadow DOM - they work at ANY depth.**

```bash
# Take snapshot - shows elements inside Shadow DOM with refs
bp snapshot --format text
# Output: textbox "Deep input" [ref=e62]

# Use ref to interact (works regardless of shadow nesting depth)
bp exec '{"action":"fill","selector":"ref:e62","value":"hello"}'
```

CSS selectors have limitations with Shadow DOM:
- 1-2 levels: CSS selectors usually work
- 3+ levels: CSS selectors fail, **but refs still work**

```bash
# CSS selector MAY fail for deep Shadow DOM:
bp exec '[{"action":"click","selector":"[data-testid=\"deep-button\"]"}]'
# Error: Element not found

# Ref from snapshot ALWAYS works:
bp snapshot --format text  # Shows: button "Submit" [ref=e45]
bp exec '{"action":"click","selector":"ref:e45"}'  # Works!
```

**Rule:** If a CSS selector fails for Shadow DOM, take a snapshot and use the ref instead.

## Selector Priority

Most to least reliable:

1. **`ref:eN`** - From snapshot, most reliable (works in Shadow DOM, no guessing)
2. `[data-testid="..."]` - Explicit test hooks
3. `#id` - Reliable if IDs are stable
4. `[aria-label="..."]` - Good for buttons without testids
5. Multi-selector array - Fallback pattern: `["ref:e4", "#submit", ".btn"]`

**Best practice:** Start with snapshot, use refs. Fall back to CSS selectors only when refs aren't available.

## `:has-text()` Selector Caveats

- Matches elements containing specified text content
- Does NOT match aria-label - use `[aria-label="..."]` instead
- For buttons with icons, prefer `[aria-label="Button text"]`

```bash
# FAILS for aria-label content:
button:has-text("Toggle Delta")

# WORKS:
button[aria-label="Toggle Delta"]
```

## Tips

1. **Snapshot first, then use refs** - Most reliable workflow for any page
2. **Refs solve Shadow DOM** - If CSS selector fails, snapshot and use ref
3. **Always use `--dialog`** when delete/confirm buttons might trigger native dialogs
4. **Multi-selector fallbacks**: `["ref:e4", "#submit", "button[type=submit]"]`
5. **Use optional** for dismissible elements: `{"optional": true, "timeout": 3000}`
6. **Wait for elements, not network**: `{"waitFor":"visible"}` beats `{"waitFor":"networkIdle"}`
7. **Trigger blur for validation**: `{"action":"press","key":"Tab"}` after fill
8. **Batch actions** to reduce round trips and get timing data
9. **Run `bp actions`** for complete action reference

## Troubleshooting

**"Element not found" for Shadow DOM:**
```bash
# Don't guess CSS selectors - use refs
bp snapshot --format text | grep -i "button"  # Find the ref
bp exec '{"action":"click","selector":"ref:e45"}'
```

**Session hangs after clicking button:**
```bash
# Probably a native dialog - use --dialog flag
bp exec --dialog accept '{"action":"click","selector":"#delete"}'
```

**Form validation not triggering:**
```bash
# Trigger blur after fill
bp exec '[
  {"action":"fill","selector":"#email","value":"test@example.com"},
  {"action":"press","key":"Tab"},
  {"action":"wait","selector":"[role=\"alert\"]","waitFor":"visible","timeout":3000}
]'
```
