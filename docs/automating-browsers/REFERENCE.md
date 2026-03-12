# browser-pilot Reference

This reference is for command and action details. For workflow routing, see [SKILL.md](./SKILL.md).

## Route first

- Inspect page state: `snapshot`, `page`, `forms`, `text`, `diagnose`
- Act in the browser: `exec`, `run`
- Capture a manual demo: `record`
- Analyze behavior over time: `trace`
- Exercise voice/media: `audio`
- Change browser conditions: `env`

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
{"action":"snapshot"}
{"action":"screenshot"}
{"action":"evaluate","value":"document.title"}
```

Prefer `bp eval 'document.title'` for ad hoc inspection instead of wrapping raw JS in action JSON.

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

### Retry

Any step supports bounded retries:

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

### Realtime validation

```bash
bp exec -s dev '[
  {"action":"waitForWsMessage","match":"*realtime*","where":{"type":"session.ready"}},
  {"action":"assertTextChanged","selector":"#status","from":"Connecting","to":"Live"},
  {"action":"assertNoConsoleErrors","windowMs":500}
]'
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
bp record -s demo --profile automation -f ./artifacts/demo.recording.json
bp record summary ./artifacts/demo.recording.json
bp record derive ./artifacts/demo.recording.json -o workflow.json
bp run workflow.json
```

## Troubleshooting

- selector failed: `bp diagnose '<selector>'`
- want focused behavior analysis: `bp trace summary --view ws|console|voice|permissions|media|ui|session`
- want raw live stream: `bp trace tail ...`
- want browser-state mutation: `bp env ...`

Compatibility:

- `bp listen ...` remains as a compatibility alias to `bp trace tail ...`
- prefer `--debug`; `--trace` is a legacy alias
