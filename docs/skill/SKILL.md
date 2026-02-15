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

Test audio-based AI agents (voice assistants, phone agents, audio chatbots) by injecting microphone input and capturing spoken responses.

> **Full guide:** [VOICE_AGENT_TESTING.md](./VOICE_AGENT_TESTING.md) — setup, troubleshooting decision tree, validation checklist, multi-turn patterns.

**Requires:** `OPENAI_API_KEY` env var for `--transcribe`. Chrome with `--remote-debugging-port=9222`.

### Quick Start

```bash
bp connect --provider generic --name vt
bp exec -s vt '{"action":"goto","url":"https://my-voice-app.com"}'
sleep 3
bp audio check -s vt                # auto-sets up + validates pipeline
bp audio roundtrip -s vt -i prompt.wav --transcribe --silence-timeout 1500
```

### Critical: Setup Order

Audio overrides MUST exist BEFORE the voice agent creates its AudioContext. If the agent auto-starts on page load, reload after setup:

```bash
bp audio setup -s vt
bp exec -s vt '{"action":"goto","url":"https://my-voice-app.com"}'
sleep 3
bp audio check -s vt   # expect "READY for roundtrip"
```

If `bp audio check` shows 0 AudioContexts or `NOT READY` — the agent initialized before overrides. Reload the page.

### Key Options

| Option | Default | Use |
|--------|---------|-----|
| `--silence-timeout` | 1500ms | Increase for agents with long pauses |
| `--transcribe` | off | Transcribe response via Whisper |
| `--verbose` | off | Debug: per-chunk RMS, silence detection |
| `-o response.wav` | none | Save response audio |
| `--send-selector` | none | Push-to-talk UIs |
| `--pre-delay` | 0 | Wait before playing input |
| `--json` | off | CI/scripting output |

### Common Patterns

```bash
# Push-to-talk
bp audio roundtrip -i prompt.wav --send-selector "#send-btn" --transcribe

# Capture-only (agent already speaking)
bp audio capture --transcribe --silence-timeout 1500

# Generate test audio from text
uv run docs/skill/generate-audio.py "Hello, what can you help me with?" -o prompt.wav

# Multi-turn conversation
bp audio roundtrip -s vt -i greeting.wav --transcribe --silence-timeout 1500
bp audio roundtrip -s vt -i question.wav --transcribe --silence-timeout 1500
```

### Diagnosing Issues

Run `bp audio check` first. Then see [VOICE_AGENT_TESTING.md](./VOICE_AGENT_TESTING.md) for the full troubleshooting decision tree.

| Symptom | Quick Fix |
|---------|-----------|
| 0 AudioContexts | Agent not initialized — wait, interact, or reload |
| `NOT READY` | Overrides missing — `bp audio setup`, then reload |
| `latencyMs: -1` | Agent didn't respond — check `bp audio check` |
| Garbage transcript | Sample rate issue — use `--verbose` to check |
| Capture runs forever | No audio arriving — 15s `noAudioTimeout` should trigger |

## Tips

1. **Use `bp snapshot -i`** - Shows only actionable elements, faster to scan than full tree
2. **Refs solve Shadow DOM** - If CSS selector fails, use ref from snapshot
3. **Always use `--dialog`** when actions might trigger native dialogs
4. **Use `blur: true` for React/Vue forms** - Ensures state sync on controlled inputs
5. **Use `bp diagnose`** when selectors fail - Shows why and suggests alternatives
6. **Use `bp eval`** for quick JS checks - No JSON wrapping needed
7. **Use `bp exec -f`** for complex multi-step actions - Avoids shell escaping
8. **Use `--json` for scripting** - Cleaner than `-f json`
9. **Use `--export-log` for debugging** - Keeps local copy of session logs
10. **Voice agents: setup order matters** - Inject audio overrides BEFORE activating the voice agent, or capture returns empty
11. **Voice transcript is silence?** - Run `bp audio check` first, then use `--verbose` to diagnose capture issues
12. **Validate audio pipeline** - `bp audio check` shows overrides, AudioContexts, taps, and fake mic status
13. **Debug a past session** - `bp list -s <name> --log-tail 50` shows recent actions; `cat $(bp list -s <name> --log-path)` dumps the full JSONL execution log

---

> **More:** [Action DSL Reference](./REFERENCE.md#action-dsl-reference) | [Patterns](./REFERENCE.md#common-patterns) | [Troubleshooting](./REFERENCE.md#troubleshooting)
