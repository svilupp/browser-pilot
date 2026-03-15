# CLI Guide

The `bp` CLI is organized around jobs, not alphabetical commands.

For local Chrome on Chrome 144+, try plain `bp connect` first after enabling remote debugging in `chrome://inspect/#remote-debugging`. Only add `--channel` or `--user-data-dir` when auto-discovery finds multiple eligible profiles.

## Install

```bash
bun add browser-pilot
# or
npm install browser-pilot
```

Global options:

- `-s, --session <id>` select a session
- `--json` emit machine-readable output
- `--debug` enable CDP transport logs
- `--trace` legacy alias for `--debug`

## Inspect

Choose this when you need to understand the page before acting.

Primary commands:

- `bp snapshot`
- `bp page`
- `bp forms`
- `bp text`
- `bp targets`
- `bp diagnose`
- `bp review`

Canonical flow:

```bash
bp connect --name dev
bp snapshot -i -s dev
bp page -s dev
bp diagnose -s dev "submit"
bp review -s dev --json
```

Rules:

- Start with `bp snapshot -i` for most automation tasks.
- Use refs like `ref:e4` in later `bp exec` calls.
- Take a new snapshot after navigation or major DOM changes.

Likely next steps:

- `bp exec -s dev '[...]'`
- `bp text -s dev --selector '#main'`
- `bp diagnose -s dev '<selector>'`

## Automate

Choose this when you already know what to do.

Primary commands:

- `bp exec`
- `bp run`

Inline automation:

```bash
bp exec -s dev '[
  {"action":"goto","url":"https://example.com"},
  {"action":"click","selector":"ref:e4"},
  {"action":"assertText","expect":"Saved"}
]'
```

Saved workflow:

```bash
bp run workflow.json --json
```

Trace-backed waits and assertions available in `exec` / `run`:

- `waitForWsMessage`
- `assertNoConsoleErrors`
- `assertTextChanged`
- `assertPermission`
- `assertMediaTrackLive`

Example:

```bash
bp exec -s dev '[
  {"action":"waitForWsMessage","match":"*realtime*","where":{"type":"session.ready"}},
  {"action":"assertTextChanged","selector":"#status","from":"Connecting","to":"Live"},
  {"action":"assertNoConsoleErrors","windowMs":500}
]'
```

Outcome conditions available on any action step:

- `expectAny`, `expectAll`, `failIf` — verify the action's effect
- `dangerous` — prevent auto-retry on ambiguous outcomes

Example:

```bash
bp exec -s dev '[
  {"action":"click","selector":"#save",
   "expectAny":[{"kind":"textAppears","text":"Saved"}],
   "dangerous":true}
]'
```

New widget actions:

- `chooseOption` — custom combobox interaction
- `upload` — file upload with verification
- `review` — structured page state extraction
- `delta` — page change detection

Likely next steps:

- `bp exec --record -f workflow.json`
- `bp trace summary -s dev --view console`
- `bp diagnose -s dev '<selector>'`

## Record

Choose this when a human is demonstrating the workflow and you want automation later.

Primary commands:

- `bp record`
- `bp record summary`
- `bp record inspect`
- `bp record derive`
- `bp record export`

Canonical flow:

```bash
bp record -s demo --profile automation -f ./artifacts/demo.recording.json
# perform the flow, then stop with Ctrl+C
bp record summary ./artifacts/demo.recording.json
bp record derive ./artifacts/demo.recording.json -o workflow.json
bp run workflow.json
```

Use profiles when they matter:

- `automation`
- `realtime`
- `voice`
- `auth`

Rules:

- Summary first, raw JSON later.
- Use `record` for human capture.
- Use `exec --record` when you already have steps and want screenshot proof of replay.

Likely next steps:

- `bp record inspect <artifact>`
- `bp trace summary <artifact> --view ws`
- `bp run workflow.json`

## Trace

Choose this when the question spans time, failures, causality, network, console, permissions, media, or voice.

Primary commands:

- `bp trace start`
- `bp trace tail`
- `bp trace summary`
- `bp trace watch`
- `bp trace export`
- `bp trace merge`

Views:

- `ws`
- `voice`
- `console`
- `permissions`
- `media`
- `ui`
- `session`

Live workflow:

```bash
bp trace start -s realtime --timeout 20000
# reproduce the issue
bp trace summary -s realtime --view ws
bp trace summary -s realtime --view console
```

Saved artifact workflow:

```bash
bp trace summary ./artifacts/demo.recording.json --view ws
bp trace export ./artifacts/demo.recording.json -o trace-bundle.json
```

Watch examples:

```bash
bp trace watch -s realtime --view ws --assert profile:reconnect --timeout 15000
bp trace watch -s realtime --view console --assert no-console-errors --timeout 5000
```

Compatibility:

- `bp listen ws ...` still works, but prefer `bp trace tail ws ...`.

Likely next steps:

- `bp trace export -s realtime -o trace-bundle.json`
- `bp env network offline -s realtime --duration 5000`
- `bp exec -s realtime '[...]'`

## Audio

Choose this when you need active voice/media control.

Primary commands:

- `bp audio setup`
- `bp audio check`
- `bp audio play`
- `bp audio capture`
- `bp audio roundtrip`

Canonical flow:

```bash
bp connect --name voice-test
bp audio setup -s voice-test
bp exec -s voice-test '{"action":"goto","url":"https://my-voice-app.com"}'
bp audio check -s voice-test
bp audio roundtrip -s voice-test -i prompt.wav --transcribe -o response.wav
bp trace summary -s voice-test --view voice
```

Rules:

- Inject audio before the app initializes its audio pipeline.
- Use `audio` for active control.
- Use `trace summary --view voice` for explanation.

Likely next steps:

- `bp record -s voice-test --profile voice -f ./artifacts/voice.recording.json`
- `bp env permissions grant -s voice-test microphone`
- `bp trace summary -s voice-test --view voice`

## Env

Choose this when you need browser-state controls without custom eval or raw CDP calls.

Primary commands:

- `bp env permissions ...`
- `bp env network ...`
- `bp env visibility ...`
- `bp env geolocation ...`

Examples:

```bash
bp env permissions grant -s dev microphone
bp env network offline -s dev --duration 5000
bp env network throttle -s dev --latency 200 --down 128kbps --up 64kbps
bp env visibility hidden -s dev
bp env geolocation set -s dev --lat 37.7749 --lon -122.4194
```

Likely next steps:

- `bp trace watch -s dev --view ws --assert profile:reconnect`
- `bp exec -s dev '[{"action":"assertPermission","name":"geolocation","state":"granted"}]'`

## Session lifecycle

Core session commands:

- `bp connect`
- `bp list`
- `bp close`
- `bp clean`
- `bp daemon`

Examples:

```bash
bp connect --name dev
bp list --json
bp close -s dev
bp clean --max-size 500MB
bp daemon status
```

## Routing summary

- Need targets or refs: `snapshot`
- Need compact overview: `page`
- Need to act now: `exec`
- Need to replay saved steps: `run`
- Need to capture a human demo: `record`
- Need to explain behavior over time: `trace`
- Need voice/media control: `audio`
- Need browser-state manipulation: `env`
- Need structured business state: `review`
