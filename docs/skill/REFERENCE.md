# browser-pilot Reference

Complete action reference, selector guide, patterns, and troubleshooting.

> For workflow guide and quick start, see [SKILL.md](./SKILL.md).

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
{"action": "fill", "selector": "#input", "value": "test", "blur": true}
```

Options: `clear` (default: true), `blur` (default: false - triggers blur for React/Vue state sync)

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

Example workflow:
```json
[
  {"action": "switchFrame", "selector": "iframe#payment"},
  {"action": "fill", "selector": "#card-number", "value": "4242424242424242"},
  {"action": "switchToMain"},
  {"action": "click", "selector": "#submit-order"}
]
```

Note: Cross-origin iframes cannot be accessed due to browser security.

## Selectors

### Ref-Based Selectors (Recommended)

Refs are the most reliable way to target elements. They work inside Shadow DOM at any depth.

```bash
# Take snapshot to populate ref cache
bp exec '[{"action":"goto","url":"https://example.com"},{"action":"snapshot"}]'
# Output:
#   button "Submit" [ref=e4]
#   textbox "Email" [ref=e5]
#   textbox "Deep input" [ref=e62]  <- Even inside Shadow DOM!

# Use refs (cache persists for this session+URL)
bp exec '[
  {"action":"fill","selector":"ref:e5","value":"test@example.com"},
  {"action":"fill","selector":"ref:e62","value":"works in Shadow DOM"},
  {"action":"click","selector":"ref:e4"}
]'
```

**Rules:**
- Take a snapshot before using refs (populates cache for this session+URL)
- Refs reset on navigation - take a new snapshot after `goto` or form submit
- Use `ref:` prefix: `"selector": "ref:e4"`
- Combine with CSS fallbacks: `["ref:e4", "#submit", "button[type=submit]"]`

### Multi-Selector Arrays

Every selector field accepts an array. Tries each until one succeeds:

```json
{"action": "click", "selector": ["#submit", "button[type=submit]", ".submit-btn"]}
```

Use for robust automation when selectors might vary.

### Selector Priority

Most to least reliable:

1. **`ref:eN`** - From snapshot, most reliable (works in Shadow DOM)
2. `[data-testid="..."]` - Explicit test hooks
3. `#id` - Reliable if IDs are stable
4. `[aria-label="..."]` - Good for buttons without testids
5. Multi-selector array - Fallback pattern: `["ref:e4", "#submit", ".btn"]`

### When to Use Refs vs CSS

| Situation | Use |
|-----------|-----|
| Shadow DOM elements | `ref:eN` (CSS often fails) |
| Dynamic/generated IDs | `ref:eN` |
| Stable test hooks exist | `[data-testid="..."]` or `ref:eN` |
| Cookie banners (unknown structure) | Multi-selector array |

### Shadow DOM

**Use refs for Shadow DOM - they work at ANY depth.**

CSS selectors have limitations:
- 1-2 levels: CSS selectors usually work
- 3+ levels: CSS selectors fail, **but refs still work**

```bash
# CSS selector MAY fail for deep Shadow DOM:
bp exec '[{"action":"click","selector":"[data-testid=\"deep-button\"]"}]'
# Error: Element not found

# Ref from snapshot works:
bp exec '[{"action":"click","selector":"ref:e45"}]'
```

### :has-text() Caveats

- Matches elements containing specified text content
- Does NOT match aria-label - use `[aria-label="..."]` instead

```bash
# FAILS for aria-label content:
button:has-text("Toggle Delta")

# WORKS:
button[aria-label="Toggle Delta"]
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

### Error Handling

Batch with `onFail: stop` (default) stops on first failure.

Check result for failures:
```bash
result=$(bp exec -o json '[...]')
success=$(echo "$result" | jq '.success')
if [ "$success" = "false" ]; then
  echo "Failed at step: $(echo "$result" | jq '.stoppedAtIndex')"
fi
```

## Common Patterns

### Login Flow (Using Refs)

```bash
# Navigate and get refs
bp exec '[
  {"action":"goto","url":"https://app.example.com/login"},
  {"action":"snapshot"}
]'
# Output: textbox "Email" [ref=e3], textbox "Password" [ref=e5], button "Login" [ref=e7]

# Fill using refs
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
# Get refs from snapshot, then use them:
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

## Troubleshooting

### "Element not found" for Shadow DOM

Don't guess CSS selectors - use refs:
```bash
bp exec '[{"action":"snapshot"}]' | grep -i "button"  # Find the ref
bp exec '[{"action":"click","selector":"ref:e45"}]'   # Use it
```

### Session Hangs After Clicking Button

Probably a native dialog - use `--dialog` flag:
```bash
bp exec --dialog accept '{"action":"click","selector":"#delete"}'
```

### Form Validation Not Triggering (React/Vue)

Use the `blur` option or trigger blur manually:
```bash
# Option 1: Use blur option (recommended for React/Vue)
bp exec '[
  {"action":"fill","selector":"#email","value":"test@example.com","blur":true},
  {"action":"wait","selector":"[role=\"alert\"]","waitFor":"visible","timeout":3000}
]'

# Option 2: Trigger blur manually with Tab
bp exec '[
  {"action":"fill","selector":"#email","value":"test@example.com"},
  {"action":"press","key":"Tab"},
  {"action":"wait","selector":"[role=\"alert\"]","waitFor":"visible","timeout":3000}
]'
```

### Refs Not Working

- Did you take a snapshot first? Refs require a snapshot to populate the cache
- Did the page navigate? Take a new snapshot after navigation
- Is the session still active? Check with `bp list`
