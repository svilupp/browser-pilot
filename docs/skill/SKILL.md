---
name: browser-pilot
description: Browser automation skill using browser-pilot CLI. Use this when you need to control a web browser - navigate to URLs, fill forms, click buttons, extract page content, or take screenshots. Works with local Chrome, BrowserBase, and Browserless providers.
compatibility: Requires browser-pilot CLI (bp). Install with `bun add browser-pilot` or `npm install browser-pilot`. For local browser, Chrome must be running with --remote-debugging-port=9222.
---

# Browser Automation with browser-pilot

Control web browsers via the `bp` CLI. Execute actions, extract content, and automate workflows.

## Quick Reference

```bash
# Connect to browser
bp connect --provider generic              # Local Chrome (auto-discovers)
bp connect --provider browserbase --name s # Cloud browser

# Execute actions
bp exec '{"action":"goto","url":"https://example.com"}'
bp exec '[{"action":"fill","selector":"#q","value":"search"},{"action":"submit","selector":"form"}]'

# Get page state
bp snapshot --format text                  # Accessibility tree (best for LLMs)
bp snapshot --format interactive           # Only interactive elements
bp text --selector ".content"              # Extract text from selector
bp screenshot --output page.png            # Take screenshot

# Session management
bp list                                    # List sessions
bp close -s session-name                   # Close session
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
```

### Wait
```json
{"action": "wait", "selector": ".loaded", "waitFor": "visible"}
{"action": "wait", "selector": ".spinner", "waitFor": "hidden"}
{"action": "wait", "waitFor": "navigation"}
{"action": "wait", "waitFor": "networkIdle"}
```

### Extract Content
```json
{"action": "snapshot"}
{"action": "screenshot"}
{"action": "screenshot", "fullPage": true, "format": "jpeg", "quality": 80}
```

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

### Login Flow
```bash
bp exec -s session '[
  {"action":"goto","url":"https://app.example.com/login"},
  {"action":"fill","selector":["#email","input[name=email]"],"value":"user@example.com"},
  {"action":"fill","selector":["#password","input[type=password]"],"value":"password"},
  {"action":"click","selector":".remember-me","optional":true},
  {"action":"submit","selector":"form"},
  {"action":"wait","waitFor":"navigation"},
  {"action":"snapshot"}
]' --output json
```

### Search and Extract Results
```bash
bp exec -s session '[
  {"action":"goto","url":"https://search.example.com"},
  {"action":"fill","selector":"#q","value":"browser automation"},
  {"action":"submit","selector":"form"},
  {"action":"wait","waitFor":"networkIdle"},
  {"action":"snapshot"}
]' --output json
```

### Handle Cookie Consent
```bash
bp exec -s session '[
  {"action":"goto","url":"https://example.com"},
  {"action":"click","selector":["#accept-cookies",".cookie-accept","[data-testid=accept]"],"optional":true,"timeout":3000},
  {"action":"snapshot"}
]'
```

### Form with Custom Dropdown
```bash
bp exec -s session '[
  {"action":"goto","url":"https://form.example.com"},
  {"action":"fill","selector":"#name","value":"John Doe"},
  {"action":"select","trigger":".country-dropdown","option":".dropdown-item","value":"United States","match":"text"},
  {"action":"check","selector":"#terms"},
  {"action":"submit","selector":"form"}
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

## Tips

1. **Always use multi-selectors** for robustness: `["#id", ".class", "[aria-label=...]"]`
2. **Use snapshots** to understand page state before acting
3. **Add waits after navigation** with `{"action":"wait","waitFor":"networkIdle"}`
4. **Use optional** for dismissible elements like cookie banners
5. **Batch actions** to reduce round trips and get timing data
6. **Check JSON output** with `--output json` for programmatic processing
