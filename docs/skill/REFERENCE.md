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
{"action": "submit", "selector": "form#login"}
{"action": "submit", "selector": "#btn", "method": "click"}
```

When targeting a `<form>` element, uses `form.requestSubmit()` which:
- Fires the `submit` event (allows JS handlers to run)
- Triggers HTML5 validation
- Works even without a submit button in the form

When targeting a submit button, uses the configured method (enter, click, or both).

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
bp exec '...' --json          # Structured JSON
bp exec '...' -o json         # Same as --json (long form)
bp exec '...' -o pretty       # Human-readable (default)
bp exec '...' --pretty        # Same as -o pretty
```

JSON output structure:
```json
{
  "success": true,
  "totalDurationMs": 1500,
  "steps": [
    {"action": "goto", "success": true, "durationMs": 1200},
    {"action": "click", "success": true, "durationMs": 50, "selectorUsed": "#email"},
    {"action": "snapshot", "success": true, "result": "..."}
  ]
}
```

Note: `selectorUsed` shows the actual selector that matched, even when using multi-selector arrays.

### Error Handling

Batch with `onFail: stop` (default) stops on first failure.

Check result for failures:
```bash
result=$(bp exec --json '[...]')
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

## Debugging Tools

### Diagnose Selector Issues

When a selector isn't working, diagnose it:

```bash
# Find out why #submit-button can't be found
bp diagnose '#submit-button' -s mysession

# Machine-readable output for automated debugging
bp diagnose '#submit' -s mysession --json --max 10
```

Output includes:
- **Exact matches** with visibility issues (hidden, disabled, covered)
- **Fuzzy matches** with similar element names and confidence scores
- **Suggested selectors** based on matching elements

### Compare Page States

Track what changed after actions:

```bash
# Capture initial state
bp snapshot -s mysession > before.json

# Perform actions
bp exec -s mysession '[{"action":"click","selector":"ref:e4"}]'

# See what changed
bp snapshot -s mysession --diff before.json
```

Shows added, removed, and modified elements.

### Visual Inspection

Inject ref labels directly onto the page:

```bash
# Inject labels and keep them visible
bp snapshot -s mysession --inspect --keep

# Labels auto-remove after 10 seconds without --keep
bp snapshot -s mysession --inspect
```

### Session Logs

View command history with timing and errors:

```bash
# Show last 10 commands
bp list -s mysession --log-tail 10

# Get log file path for external tools
bp list -s mysession --log-path

# Full session info including log stats
bp list -s mysession --info
bp list -s mysession --info --json  # Machine-readable
```

Logs are in JSONL format at `~/.browser-pilot/sessions/{id}/log.jsonl`.

**Export logs for local analysis:**
```bash
# On connect, specify export path
bp connect -s mysession --export-log ./test-results/session.jsonl

# All subsequent commands automatically duplicate to export log
# Both files contain identical entries
```

### Failure Hints

When `ElementNotFoundError` is thrown, the error includes suggested alternatives based on fuzzy matching against the current page snapshot. This helps you quickly identify correct selectors when your original selector fails.

**Hint Structure:**
```json
{
  "selector": "ref:e4",
  "reason": "Similar name: 'Submit Form'",
  "confidence": "high",
  "element": {"ref": "e4", "role": "button", "name": "Submit Form"}
}
```

**Confidence Levels:**
- `high` (score >= 0.8): Strong match, likely the correct element
- `medium` (score >= 0.5): Possible match, worth trying
- `low` (score < 0.5): Weak match, verify manually before using

**Action-Type Filtering:**

Hints are automatically filtered to show only elements with appropriate roles for your action type:

| Action | Suggested Roles |
|--------|-----------------|
| `click` | buttons, links, menuitems, tabs |
| `fill` | textboxes, searchboxes, spinbuttons |
| `submit` | buttons, forms |
| `select` | comboboxes, listboxes |
| `check` | checkboxes, radios, switches |

**In Batch Results:**

When using `bp exec --json`, hints appear in failed step results:
```json
{
  "success": false,
  "stoppedAtIndex": 1,
  "steps": [
    {"action": "goto", "success": true, "durationMs": 1200},
    {
      "action": "click",
      "success": false,
      "error": "Element not found: #submit",
      "hints": [
        {"selector": "ref:e4", "reason": "Similar name: 'Submit'", "confidence": "high", "element": {"ref": "e4", "role": "button", "name": "Submit"}},
        {"selector": "ref:e8", "reason": "Same role: button", "confidence": "medium", "element": {"ref": "e8", "role": "button", "name": "Cancel"}}
      ]
    }
  ]
}
```

**Using Hints:**

1. **Retry with suggested selector:** Use the `selector` value from a high-confidence hint
2. **Build resilient selectors:** Combine hints with your original selector as fallbacks

```json
{"action": "click", "selector": ["ref:e4", "#submit-btn", "button[type=submit]"]}
```

3. **Verify before using:** For medium/low confidence hints, take a snapshot to confirm the element is correct

## Voice Agent Testing

Use `bp audio` to test audio-based AI apps. The typical pattern: navigate to the voice agent page, send an audio prompt, wait for the response, and transcribe it.

### Full Round-Trip

```bash
# Send audio prompt, capture and transcribe the response
bp audio roundtrip -i question.wav --transcribe --silence-timeout 5000
```

Output (with `--json`):
```json
{
  "success": true,
  "latencyMs": 1200,
  "totalMs": 5800,
  "audio": { "durationMs": 3200, "sampleRate": 48000, "samples": 153600, "chunks": 4 },
  "transcript": "The answer is forty-two"
}
```

### Multi-Turn Conversation

```bash
# Turn 1
bp audio roundtrip -i turn1.wav --transcribe --silence-timeout 5000
# Turn 2
bp audio roundtrip -i turn2.wav --transcribe --silence-timeout 5000
# Turn 3 (just capture what the agent says next)
bp audio capture --transcribe --silence-timeout 8000
```

### Silence Timeout Tuning

Voice agents take varying time to respond. The `--silence-timeout` flag controls how long to wait after the last audio before assuming the response is complete.

| Agent Type | Recommended `--silence-timeout` |
|------------|--------------------------------|
| Fast voice bot | 2000-3000ms |
| LLM-based voice agent | 4000-6000ms |
| Complex reasoning agent | 6000-10000ms |

### Transcription Setup

`--transcribe` requires `OPENAI_API_KEY`. It's validated **immediately** when the flag is used — you'll get a clear error before any audio processing starts.

```bash
export OPENAI_API_KEY=sk-...  # Get at https://platform.openai.com/api-keys
bp audio roundtrip -i prompt.wav --transcribe --silence-timeout 5000
```

Transcription adds ~1-2s overhead (Whisper API). Safe to use in hot loops and CI.

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
