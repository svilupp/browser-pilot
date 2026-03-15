---
name: automate-browser-actions-and-testing
description: Browser automation skill using browser-pilot CLI. Use this when you need to control a web browser, inspect a page, capture a workflow, trace a realtime issue, or exercise voice and environment conditions.
compatibility: Requires browser-pilot CLI (bp). For local Chrome on Chrome 144+, enable remote debugging in chrome://inspect/#remote-debugging before running bp connect.
---

# Browser Automation with browser-pilot

Route the task before choosing commands.

For local Chrome on Chrome 144+, try plain `bp connect` first after enabling remote debugging in `chrome://inspect/#remote-debugging`. Only narrow with `--channel` or `--user-data-dir` if auto-discovery is ambiguous.

## Routing tree

1. Inspect the page: `bp snapshot`, `bp page`, `bp forms`, `bp text`, `bp diagnose`
2. Act in the browser: `bp exec`, `bp run`
3. Capture a human demo: `bp record`
4. Analyze time-based behavior: `bp trace`
5. Exercise voice/media or browser conditions: `bp audio`, `bp env`

## Default automation workflow

```bash
bp connect --name dev
bp snapshot -i -s dev
bp exec -s dev '[
  {"action":"fill","selector":"ref:e5","value":"user@example.com"},
  {"action":"click","selector":"ref:e7"}
]'
```

If multiple Chrome profiles are eligible, use `bp connect --channel beta` or `bp connect --user-data-dir <path>`.

Rules:

- Prefer refs from `bp snapshot -i`
- Prefer high-level actions over `bp eval`
- After navigation, take a fresh snapshot
- If a selector fails, use `bp diagnose` before dropping to raw JS

## When to use record

Use `record` when the workflow is being demonstrated manually.

```bash
bp record -s demo --profile automation -f ./artifacts/demo.recording.json
bp record summary ./artifacts/demo.recording.json
bp record derive ./artifacts/demo.recording.json -o workflow.json
bp run workflow.json
```

Do not start by reading the raw artifact.

## When to use trace

Use `trace` when the question spans time, websocket traffic, console failures, permission state, media, or voice.

```bash
bp trace start -s dev --timeout 20000
bp trace summary -s dev --view ws
bp trace watch -s dev --view console --assert no-console-errors --timeout 5000
```

`bp listen ...` is compatibility only. Prefer `bp trace tail ...`.

## Voice and environment workflows

Voice control:

```bash
bp audio setup -s vt
bp exec -s vt '{"action":"goto","url":"https://my-voice-app.com"}'
bp audio check -s vt
bp audio roundtrip -s vt -i prompt.wav --transcribe
bp trace summary -s vt --view voice
```

Browser-state controls:

```bash
bp env permissions grant -s vt microphone
bp env network offline -s vt --duration 5000
bp env visibility hidden -s vt
```

## Trace-backed assertions in exec/run

Useful steps for realtime and voice apps:

- `waitForWsMessage`
- `assertNoConsoleErrors`
- `assertTextChanged`
- `assertPermission`
- `assertMediaTrackLive`

Example:

```bash
bp exec -s vt '[
  {"action":"waitForWsMessage","match":"*realtime*","where":{"type":"session.ready"}},
  {"action":"assertTextChanged","selector":"#status","from":"Connecting","to":"Live"},
  {"action":"assertNoConsoleErrors","windowMs":500}
]'
```

## Quick command map

- Discover elements: `bp snapshot -i`
- Compact overview: `bp page`
- Execute inline steps: `bp exec`
- Execute saved file: `bp run`
- Record demo: `bp record`
- Summarize artifact or live trace: `bp trace summary`
- Active voice control: `bp audio`
- Browser conditions: `bp env`
