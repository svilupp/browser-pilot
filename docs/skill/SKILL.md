---
name: automate-browser-actions-and-testing
description: Browser automation skill using browser-pilot CLI. Use this when you need to control a web browser - navigate to URLs, fill forms, click buttons, extract page content, or take screenshots. Works with local Chrome, BrowserBase, and Browserless providers.
compatibility: Requires browser-pilot CLI (bp). Install with `bun add browser-pilot` or `npm install browser-pilot`. For local browser, Chrome must be running with --remote-debugging-port=9222.
---

# Browser Automation with browser-pilot

Control web browsers via the `bp` CLI. Execute actions, extract content, and automate workflows.

> For complete action reference, patterns, and troubleshooting, see [REFERENCE.md](./REFERENCE.md).

## The Workflow: Snapshot → Ref

**Always use refs from snapshots for reliable element targeting.** Refs work even inside Shadow DOM.

```bash
# Step 1: Navigate to the page
bp exec '{"action":"goto","url":"https://example.com"}'

# Step 2: See interactive elements (buttons, inputs, links)
bp snapshot -i
# Output:
#   ref: e4, role: button, name: Submit
#   ref: e5, role: textbox, name: Email

# Step 3: Use refs (cached for this session+URL)
bp exec '[
  {"action":"fill","selector":"ref:e5","value":"user@example.com"},
  {"action":"click","selector":"ref:e4"}
]'

# Step 4: After navigation, snapshot again
bp snapshot -i
```

**Use `bp snapshot -i` (not full snapshot) for most workflows.** It shows only actionable elements — buttons, links, inputs — so you find what to click/fill immediately without wading through layout nodes.

**Why refs?** Work in Shadow DOM, no CSS guessing, stable within page load, cached across CLI calls.

## Quick Reference

```bash
# Connect
bp connect --provider generic              # Local Chrome (auto-discovers)
bp connect --provider generic --export-log ./logs/session.jsonl  # With local logs
bp connect --provider browserbase --name s # Cloud browser

# Snapshot
bp snapshot -i                         # Interactive elements only (recommended)
bp snapshot --format text              # Full accessibility tree

# Execute actions
bp exec '[{"action":"goto","url":"..."}]'
bp exec '[{"action":"click","selector":"ref:e4"}]'
bp exec -f actions.json               # Read actions from file
echo '{"action":"snapshot"}' | bp exec # Pipe from stdin

# Evaluate JavaScript (no JSON wrapping needed)
bp eval 'document.title'
bp eval 'document.querySelectorAll("audio").length'

# Handle dialogs (CRITICAL - blocks without this)
bp exec --dialog accept '{"action":"click","selector":"#delete-btn"}'

# Session management
bp list                    # List sessions
bp list --json             # JSON output
bp close -s session-name   # Close session
bp actions                 # Complete action reference
```

## Basic Workflow

### 1. Connect

```bash
bp connect --provider generic --name dev              # Local Chrome
bp connect --provider browserbase --name prod --api-key $KEY  # Cloud
```

### 2. Execute Actions

```bash
bp exec -s dev '[
  {"action":"goto","url":"https://example.com/login"},
  {"action":"fill","selector":"#email","value":"user@example.com"},
  {"action":"submit","selector":"form"},
  {"action":"wait","waitFor":"navigation"},
  {"action":"snapshot"}
]'
```

### 3. Read Page State

```bash
bp snapshot -i                          # Interactive elements only (recommended)
bp snapshot --format text               # Full accessibility tree
bp snapshot                             # Full snapshot (JSON)
```

**Use `bp snapshot -i` by default.** It returns only clickable/fillable elements with their refs — much faster to scan than the full tree. Use `--format text` only when you need to read non-interactive content (headings, paragraphs, labels).

### 4. Close When Done

```bash
bp close -s dev
```

## Dialog Handling (CRITICAL)

Native browser dialogs (`alert()`, `confirm()`, `prompt()`) **block ALL automation** until handled.

```bash
# ALWAYS use --dialog when actions might trigger native dialogs
bp exec --dialog accept '[{"action":"click","selector":"#delete-btn"}]'
bp exec --dialog dismiss '[{"action":"click","selector":"#cancel-action"}]'
```

Custom modals (`role="dialog"`) work fine without this flag.

## Multi-Selector & Optional Actions

Every selector accepts an array - tries each until one succeeds:
```json
{"action": "click", "selector": ["#submit", "button[type=submit]", ".submit-btn"]}
```

Use `optional: true` to skip gracefully if element not found:
```json
{"action": "click", "selector": "#cookie-banner", "optional": true, "timeout": 3000}
```

## React/Vue State Verification

browser-pilot operates at the DOM level and cannot directly access framework state. Use these patterns:

**Use `blur` option for controlled inputs:**
```json
{"action":"fill","selector":"#email","value":"user@example.com","blur":true}
```

**Check state via evaluate:**
```bash
bp eval 'window.__REACT_STATE__ || window.__VUEX_STATE__'
```

**Trigger blur manually for validation:**
```json
[
  {"action":"fill","selector":"#email","value":"test@example.com"},
  {"action":"press","key":"Tab"}
]
```

**Check dataLayer for analytics:**
```bash
bp eval 'window.dataLayer'
```

## Debugging

When element selection fails, use these diagnostic tools:

```bash
# Why can't this selector be found?
bp diagnose '#submit-button' -s dev
bp diagnose '#submit-button' -s dev --json  # Machine-readable

# What changed on the page?
bp snapshot -s dev --json > before.json
# ... perform actions ...
bp snapshot -s dev --diff before.json

# Visual inspection with ref labels
bp snapshot -s dev --inspect --keep

# View recent command history with errors
bp list -s dev --log-tail 10
bp list -s dev --info --json  # Full session info as JSON
```

The `diagnose` command shows:
- Exact matches with visibility issues (hidden, disabled, covered)
- Fuzzy matches with similar element names
- Suggested alternative selectors

### Failure Hints

When an element isn't found, errors include suggested alternatives:

```json
{"error": "Element not found: #submit", "hints": [
  {"selector": "ref:e4", "reason": "Similar: 'Submit Form' button", "confidence": "high"}
]}
```

Hints are action-aware—`click` suggests buttons/links, `fill` suggests inputs. Use the suggested selector in your next attempt.

## Voice Agent Testing

Test audio-based AI apps (voice assistants, phone agents, audio chatbots) by injecting microphone input and capturing spoken responses.

**Requires:** `OPENAI_API_KEY` env var for `--transcribe` (validated immediately — fails fast with helpful error if missing).

### Typical Workflow

```bash
# 1. Connect to browser
bp connect --provider generic --name voice-test

# 2. Navigate to the voice agent page
bp exec '[{"action":"goto","url":"https://my-voice-app.com"},{"action":"snapshot"}]'

# 3. Click "start call" or similar button if needed
bp exec '{"action":"click","selector":"ref:e4"}'

# 4. Full round-trip: send audio → wait for response → transcribe
bp audio roundtrip -i question.wav --transcribe --silence-timeout 5000
# Output: { "transcript": "The answer is 42", "latencyMs": 1200, ... }

# 5. Multiple turns in conversation
bp audio roundtrip -i followup.wav --transcribe --silence-timeout 5000

# 6. Push-to-talk: play audio, click send button, capture response
bp audio roundtrip -i prompt.wav --send-selector ref:e31 --transcribe

# 7. Capture-only (agent already speaking)
bp audio capture --transcribe --silence-timeout 8000

# 8. Save response audio for manual review
bp audio roundtrip -i prompt.wav -o response.wav --transcribe

# 9. Debug capture issues with --verbose
bp audio capture --verbose --transcribe --silence-timeout 5000
```

### Key Options

- **`--silence-timeout 5000`** — Voice agents take 2-8s to respond. Default 3s may cut off responses. Increase for slower agents.
- **`--transcribe`** — Adds ~1-2s (Whisper API is fast). Requires `OPENAI_API_KEY`.
- **`--language <lang>`** — Language hint for transcription (e.g. `en`, `es`, `ja`). Improves accuracy for non-English audio.
- **`--pre-delay`** — Wait before playing input if the page needs setup time.
- **`--send-selector`** — Click a button after input finishes (push-to-talk UIs).
- **`--verbose`** — Show detailed capture diagnostics (chunk RMS, connection counts).
- **`--json`** — Structured output for CI/scripting.

### Troubleshooting

- **Transcript is always silence / "you"** — Use `--verbose` to see if chunks are arriving. Check if the voice agent uses WebRTC (connections should show in verbose output).
- **Audio setup fails** — Make sure you've navigated to a real page first. `bp audio setup` on `about:blank` will error with a clear message.

### Generating Test Audio

Use the bundled TTS script to create test prompts from text:

```bash
# Generate a WAV prompt (requires OPENAI_API_KEY in env or .env in project root)
uv run docs/skill/generate-audio.py "Hello, what can you help me with?" -o prompt.wav
uv run docs/skill/generate-audio.py "Can you tell me more?" -o followup.wav

# Options
uv run docs/skill/generate-audio.py "text" --voice nova --model tts-1-hd -o high-quality.wav
```

### Environment Setup

```bash
# Required for transcription and audio generation
# Check .env in the project root if not in your shell environment
export OPENAI_API_KEY=sk-...

# Optional: Chrome with fake media device support
chrome --remote-debugging-port=9222 \
  --use-fake-device-for-media-stream \
  --use-fake-ui-for-media-stream
```

## Tips

1. **Use `bp snapshot -i`** - Shows only actionable elements, faster to scan than full tree
2. **Refs solve Shadow DOM** - If CSS selector fails, use ref from snapshot
3. **Always use `--dialog`** when actions might trigger native dialogs
4. **Use `blur: true` for React/Vue forms** - Ensures state sync on controlled inputs
5. **Use `bp diagnose`** when selectors fail - Shows why and suggests alternatives
6. **Use `bp eval`** for quick JS checks - No JSON wrapping needed
7. **Use `bp exec -f`** for complex multi-step actions - Avoids shell escaping
8. **Use `--json` for scripting** - Cleaner than `-o json`
9. **Use `--export-log` for debugging** - Keeps local copy of session logs
10. **Voice agents: increase `--silence-timeout`** - Default 3s is often too short
11. **Voice transcript is silence?** - Use `--verbose` to diagnose capture issues
12. **Debug a past session** - `bp list -s <name> --log-tail 50` shows recent actions; `cat $(bp list -s <name> --log-path)` dumps the full JSONL execution log

---

> **More:** [Action DSL Reference](./REFERENCE.md#action-dsl-reference) | [Patterns](./REFERENCE.md#common-patterns) | [Troubleshooting](./REFERENCE.md#troubleshooting)
