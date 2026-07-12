# browser-pilot Reference

This reference is for command and action details. For workflow routing, see [SKILL.md](./SKILL.md).

## Route first

- Inspect page state: `snapshot`, `page`, `forms`, `text`, `diagnose`
- Act in the browser: `exec`, `run`
- Select an exact tab: `use-target`
- Capture a manual demo: `record`
- Analyze behavior over time: `trace`
- Exercise voice/media: `audio`
- Review structured state: `review`
- Change browser conditions: `env`

## If the task is...

- Find what to click: `bp snapshot -i`
- Read long-form copy: `bp text`
- Review structured business state: `bp review`
- Debug selector failure: `bp diagnose`
- Drop to raw JavaScript only as an escape hatch: `bp eval`

## Action DSL reference

### Navigation and interaction

```json
{"action":"goto","url":"https://example.com"}
{"action":"click","selector":"#button"}
{"action":"fill","selector":"#email","value":"user@example.com"}
{"action":"type","selector":"#search","value":"query","delay":50}
{"action":"select","selector":"#country","value":"US"}
{"action":"check","selector":"#agree"}
{"action":"uncheck","selector":"#newsletter"}
{"action":"submit","selector":"form"}
{"action":"press","key":"Enter"}
{"action":"shortcut","combo":"Control+a"}
{"action":"focus","selector":"#input"}
{"action":"hover","selector":".menu-item"}
{"action":"scroll","direction":"down","amount":500}
```

### Wait and extraction

```json
{"action":"wait","selector":".loaded","waitFor":"visible"}
{"action":"wait","waitFor":"navigation"}
{"action":"wait","waitFor":"networkIdle"}
{"action":"waitForReady","any":["main"],"loadingHidden":".spinner","stableForMs":250}
{"action":"snapshot"}
{"action":"screenshot"}
{"action":"evaluate","value":"document.title"}
```

`waitFor: "networkIdle"` only means transport quiet. On hydrated apps, follow navigation with `bp snapshot -i`, `bp text`, `bp review`, or explicit assertions before trusting the page state.

Prefer `bp eval 'document.title'` only as an escape hatch for ad hoc inspection instead of wrapping raw JS in action JSON.

### Assertions

```json
{"action":"assertVisible","selector":"#success-banner"}
{"action":"assertExists","selector":"[data-loaded]"}
{"action":"assertText","expect":"Welcome back","selector":"h1"}
{"action":"assertUrl","expect":"/dashboard"}
{"action":"assertValue","selector":"#email","expect":"user@example.com"}
```

### Trace-backed waits and assertions

```json
{"action":"waitForWsMessage","match":"*realtime*","where":{"type":"session.ready"},"timeout":5000}
{"action":"assertNoConsoleErrors","windowMs":500}
{"action":"assertTextChanged","selector":"#status","from":"Connecting","to":"Live","timeout":5000}
{"action":"assertPermission","name":"microphone","state":"granted"}
{"action":"assertMediaTrackLive","kind":"audio"}
```

Use these when the app is timing-sensitive, realtime, or voice-based.

### Outcome conditions

Any action step can verify the result using conditions:

```json
{"action":"click","selector":"#save",
 "expectAny":[{"kind":"textAppears","text":"Saved"}],
 "failIf":[{"kind":"textAppears","text":"Error"}]}

{"action":"submit","selector":"form",
 "expectAll":[
   {"kind":"urlMatches","pattern":"*/dashboard*"},
   {"kind":"elementHidden","selector":".spinner"}
 ],
 "dangerous":true}
```

Condition kinds:

| Kind | Required fields | What it checks |
|------|----------------|----------------|
| `urlMatches` | `pattern` | Current URL matches glob pattern |
| `elementVisible` | `selector` | Element is visible |
| `elementHidden` | `selector` | Element is hidden or absent |
| `textAppears` | `text`, optional `selector` | Text found on page/element |
| `textChanges` | optional `to`, optional `selector` | Text content changed |
| `networkResponse` | `urlPattern`, optional `status` | HTTP response seen |
| `stateSignatureChanges` | optional `mode` | Page state fingerprint changed |
| `selectedTab` | optional `selector`, `name`, `landmark` | Selected tab matches |
| `fieldValue` | `selector`, `value` | Field has the expected value |
| `checkbox` | `selector`, `checked` | Checkbox state matches |
| `switch` | `selector`, `checked` | Switch state matches |
| `elementEnabled` | `selector`, optional `enabled` | Control enabled/disabled state matches |
| `targetCount` | `count`, optional `type` | Number of matching browser targets |
| `newTarget` | optional target/opener/url/type | A new browser target appeared |
| `urlChanged` | optional `from`, `mode` | URL changed from the prior state |
| `fieldChanged` | `selector`, optional `from`, `to` | Field value changed |

Result fields: `outcomeStatus`, `matchedConditions`, `retrySafe`.

### Page review and delta

```json
{"action":"review"}
{"action":"delta"}
```

### Widget actions

```json
{"action":"chooseOption","trigger":"#combo-trigger","value":"United States","match":"contains"}
{"action":"upload","selector":"#file-input","files":["/path/to/doc.pdf"]}
```

### Retry

Any step supports bounded retries. Before dispatch, a retry may run the action again. Once an
effectful action has dispatched (or its outcome is uncertain), retries do not blindly repeat the
input: they observe the page and re-evaluate the step's conditions. Use `effect` (`observe`,
`idempotent`, or `at_most_once`) and `dangerous` to make the intended safety boundary explicit.

```json
{"action":"click","selector":"#flaky-button","retry":2,"retryDelay":500}
{"action":"assertVisible","selector":".async-content","retry":3,"retryDelay":1000}
```

## Selectors

### Refs are the default

```bash
bp snapshot -i
# output includes ref:e4, ref:e5, ...

bp exec '[
  {"action":"fill","selector":"ref:e5","value":"user@example.com"},
  {"action":"click","selector":"ref:e4"}
]'
```

Rules:

- take a snapshot before using refs
- take a fresh snapshot after navigation
- combine refs with CSS fallbacks when needed

### Multi-selector arrays

```json
{"action":"click","selector":["ref:e4","#submit","button[type=submit]"]}
```

## Common patterns

### Inspect then act

```bash
bp snapshot -i -s dev
bp exec -s dev '[{"action":"click","selector":"ref:e4"}]'
```

### Scope noisy pages before reading

```bash
bp text -s dev --selector main
bp page -s dev
```

Use `bp text --selector ...` when storefront nav, drawers, or footer controls swamp the page-level output.

### Realtime validation

```bash
bp exec -s dev '[
  {"action":"waitForWsMessage","match":"*realtime*","where":{"type":"session.ready"}},
  {"action":"assertTextChanged","selector":"#status","from":"Connecting","to":"Live"},
  {"action":"assertNoConsoleErrors","windowMs":500}
]'
```

### Start trace analysis wide, then narrow

```bash
bp trace start -s dev --timeout 20000
bp trace summary -s dev --view session
bp trace summary -s dev --view console
```

### Voice validation

```bash
bp audio setup -s vt
bp exec -s vt '{"action":"goto","url":"https://my-voice-app.com"}'
bp audio check -s vt
bp exec -s vt '[{"action":"assertMediaTrackLive","kind":"audio"}]'
```

### Capture and derive

```bash
bp connect --name demo
bp record -s demo --profile automation -f ./artifacts/demo.recording.json
# perform the flow manually, then stop with Ctrl+C
bp record summary ./artifacts/demo.recording.json
bp record inspect ./artifacts/demo.recording.json
bp record derive ./artifacts/demo.recording.json -o ./artifacts/demo.workflow.json
jq . ./artifacts/demo.workflow.json
bp run ./artifacts/demo.workflow.json -s demo
```

`record derive` writes browser-pilot workflow JSON, not Flightplan TOML. Translate the derived steps into Flightplan manually.

### Outcome-aware submit

```bash
bp exec -s dev '[
  {"action":"fill","selector":"#email","value":"user@example.com"},
  {"action":"submit","selector":"form",
   "expectAny":[
     {"kind":"urlMatches","pattern":"*/dashboard*"},
     {"kind":"textAppears","text":"Welcome"}
   ],
   "failIf":[{"kind":"textAppears","text":"Invalid"}],
   "dangerous":true}
]'
```

### Review after action

```bash
bp exec -s dev '[{"action":"click","selector":"#save"}]'
bp review -s dev --json
```

## Troubleshooting

- selector failed: `bp diagnose '<selector>'`
- want focused behavior analysis: `bp trace summary --view ws|console|voice|permissions|media|ui|session`
- want raw live stream: `bp trace tail ...`
- want browser-state mutation: `bp env ...`

Compatibility:

- `bp listen ...` remains as a compatibility alias to `bp trace tail ...`
- prefer `--debug`; `--trace` is a legacy alias
