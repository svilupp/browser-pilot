---
name: browser-pilot
description: Browser automation skill using browser-pilot CLI. Use this when you need to control a web browser - navigate to URLs, fill forms, click buttons, extract page content, or take screenshots. Works with local Chrome, BrowserBase, and Browserless providers.
compatibility: Requires browser-pilot CLI (bp). Install with `bun add browser-pilot` or `npm install browser-pilot`. For local browser, Chrome must be running with --remote-debugging-port=9222.
---

# Browser Automation with browser-pilot

Control web browsers via the `bp` CLI. Execute actions, extract content, and automate workflows.

> For complete action reference, patterns, and troubleshooting, see [REFERENCE.md](./REFERENCE.md).

## The Workflow: Snapshot → Ref

**Always use refs from snapshots for reliable element targeting.** Refs work even inside Shadow DOM.

```bash
# Step 1: Navigate and see what's on the page
bp exec '[{"action":"goto","url":"https://example.com"},{"action":"snapshot"}]'
# Output shows refs:
#   button "Submit" [ref=e4]
#   textbox "Email" [ref=e5]

# Step 2: Use refs (cached for this session+URL)
bp exec '[
  {"action":"fill","selector":"ref:e5","value":"user@example.com"},
  {"action":"click","selector":"ref:e4"}
]'

# Step 3: After navigation, snapshot again
bp exec '{"action":"snapshot"}'
```

**Why refs?** Work in Shadow DOM, no CSS guessing, stable within page load, cached across CLI calls.

## Quick Reference

```bash
# Connect
bp connect --provider generic              # Local Chrome (auto-discovers)
bp connect --provider browserbase --name s # Cloud browser

# Execute actions
bp exec '[{"action":"goto","url":"..."},{"action":"snapshot"}]'
bp exec '[{"action":"click","selector":"ref:e4"}]'

# Handle dialogs (CRITICAL - blocks without this)
bp exec --dialog accept '{"action":"click","selector":"#delete-btn"}'

# Session management
bp list                    # List sessions
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
bp snapshot -s dev --format text        # Accessibility tree
bp snapshot -s dev --format interactive # Interactive elements only
```

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
bp exec '{"action":"evaluate","expression":"window.__REACT_STATE__ || window.__VUEX_STATE__"}'
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
bp exec '{"action":"evaluate","expression":"window.dataLayer"}'
```

## Tips

1. **Take a snapshot before using refs** - Populates the ref cache
2. **Refs solve Shadow DOM** - If CSS selector fails, use ref from snapshot
3. **Always use `--dialog`** when actions might trigger native dialogs
4. **Use `blur: true` for React/Vue forms** - Ensures state sync on controlled inputs
5. **Run `bp actions`** for complete action reference

---

> **More:** [Action DSL Reference](./REFERENCE.md#action-dsl-reference) | [Patterns](./REFERENCE.md#common-patterns) | [Troubleshooting](./REFERENCE.md#troubleshooting)
