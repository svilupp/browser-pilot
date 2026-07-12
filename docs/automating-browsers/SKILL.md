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
3. Verify outcomes: `bp review`, outcome conditions in `bp exec`
4. Capture a human demo: `bp record`
5. Analyze time-based behavior: `bp trace`
6. Exercise voice/media or browser conditions: `bp audio`, `bp env`

## If the task is...

- Find what to click or fill: `bp snapshot -i`
- Read the page copy: `bp text`
- Get a compact overview: `bp page`
- Review structured business state: `bp review`
- Debug a missing selector: `bp diagnose`
- Use raw JavaScript as a last resort: `bp eval`

## Default automation workflow

```bash
bp connect --name dev
bp exec -s dev '{"action":"goto","url":"https://example.com"}'
bp snapshot -i -s dev
bp exec -s dev '[
  {"action":"fill","selector":"ref:e5","value":"user@example.com"},
  {"action":"click","selector":"ref:e7"}
]'
```

If multiple Chrome profiles are eligible, use `bp connect --channel beta` or `bp connect --user-data-dir <path>`.

## Outcome-aware workflow

When you need to verify that an action actually worked (not just clicked):

```bash
bp exec -s dev '[
  {"action":"click","selector":"#save-btn",
   "expectAny":[
     {"kind":"textAppears","text":"Changes saved"},
     {"kind":"elementVisible","selector":"#success-toast"}
   ],
   "failIf":[{"kind":"textAppears","text":"Error"}],
   "dangerous":true}
]'
```

The result includes `outcomeStatus` (success/failed/ambiguous/unsafe_to_retry), `matchedConditions`, and `retrySafe`.

## Review page state

When you need structured business state (not raw snapshot):

```bash
bp review -s dev --json
```

Returns headings, forms, alerts, tables, key-value pairs, and status labels. Useful after form submissions, checkout flows, or any page with business data.

Rules:

- Prefer refs from `bp snapshot -i`
- `bp page` caches the refs it shows, but it is a compact overview, not a full target inventory
- On noisy pages, scope reading with `bp text --selector main` or another container
- Prefer `bp review` for confirmations, detail pages, tables, alerts, and key-values, not dense catalog grids
- Prefer `bp text` for readable copy and `bp review` for structured verification
- Prefer high-level actions over `bp eval`
- After navigation or major DOM changes, take a fresh snapshot
- If a selector fails, use `bp diagnose` before dropping to raw JS
- `waitFor: "networkIdle"` only means transport quiet; on hydrated apps follow it with `bp snapshot -i`, `bp text`, `bp review`, or an explicit assertion

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
bp trace summary -s dev --view session
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

### Outcome conditions in exec/run

Any action step can include outcome conditions:

- `expectAny`: success if any condition matches
- `expectAll`: success only if all conditions match
- `failIf`: failure if any condition matches (checked first)
- `dangerous`: never auto-retry on ambiguous outcome

Condition kinds: `urlMatches`, `elementVisible`, `elementHidden`, `textAppears`, `textChanges`,
`networkResponse`, `stateSignatureChanges`, `selectedTab`, `fieldValue`, `checkbox`, `switch`,
`elementEnabled`, `targetCount`, `newTarget`, `urlChanged`, and `fieldChanged`. Text and URL
conditions accept explicit match modes; text conditions can also be scoped by selector or landmark.

For semantic readiness, use a `waitForReady` action with `any`/`all`, `loadingHidden`, `predicate`,
or stability options instead of assuming `networkIdle` means that a hydrated page is ready.

Retries stop at the dispatch boundary: a pre-dispatch failure may retry the action, while a
dispatched or uncertain effect is observed and its conditions are re-evaluated instead of blindly
repeating input. Set `effect` to `observe`, `idempotent`, or `at_most_once` when the retry policy
needs to be explicit.

## Quick command map

- Discover elements: `bp snapshot -i`
- Compact overview: `bp page`
- Execute inline steps: `bp exec`
- Execute saved file: `bp run`
- Record demo: `bp record`
- Summarize artifact or live trace: `bp trace summary`
- Review structured state: `bp review`
- Active voice control: `bp audio`
- Browser conditions: `bp env`
