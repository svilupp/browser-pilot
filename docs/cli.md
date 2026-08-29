# CLI Guide

The `bp` CLI is organized around jobs, not alphabetical commands.

browser-pilot is the lower-level browser interface. For simple, reusable, low-cost automation,
use the companion [Flightplan](https://github.com/svilupp/flightplan) package when released:
`bunx flightplan --help`.

For local Chrome on Chrome 144+, try plain `bp connect` first after enabling remote debugging in `chrome://inspect/#remote-debugging`. Only add `--channel` or `--user-data-dir` when auto-discovery finds multiple eligible profiles.

Get oriented first:

- `bp --help` shows the routed command tree
- `bp --version` prints the CLI version

## Install

```bash
bun add browser-pilot
# or
npm install browser-pilot
```

Global options:

- `-s, --session <id>` select a session
- `--json` emit machine-readable output
- `--pretty` emit readable text output
- `--debug` enable CDP transport logs
- `--trace` legacy alias for `--debug`

Session transport:

- `bp connect` uses a persistent, browser-scoped daemon by default. Follow-up
  commands attach through its Unix socket and do not open another browser CDP
  WebSocket.
- `bp connect --no-daemon` selects direct mode explicitly.
- Set `BROWSER_PILOT_NO_DAEMON=1` for CI or other environments where detached
  processes are not allowed. The CLI never silently falls back between modes.
- Closing the last local session removes only that logical session; its
  browser-scoped daemon remains available until Chrome exits (or it is stopped
  explicitly). Use `bp daemon list`, then `bp daemon stop --daemon-id <id>`
  when no logical session remains.

## Command chooser

- `bp snapshot -i`: choose clickable/fillable targets and get refs
- `bp page`: compact page overview
- `bp forms`: enumerate form controls
- `bp text`: read long-form copy or policy content
- `bp review`: inspect structured business state after actions
- `bp diagnose`: debug missing selectors or targeting failures
- `bp exec` / `bp run`: act in the browser
- `bp use-target`: explicitly switch a session to a known tab
- `bp trace`: inspect time-based behavior

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
bp exec -s dev '{"action":"goto","url":"https://example.com"}'
bp snapshot -i -s dev
bp page -s dev
bp text -s dev --selector main
bp targets -s dev --json
bp use-target <target-id> -s dev
bp diagnose -s dev "submit"
bp review -s dev --json
```

Rules:

- Start with `bp snapshot -i` for most automation tasks.
- Use refs like `ref:e4` in later `bp exec` calls.
- Take a new snapshot after navigation or major DOM changes.
- `bp page` caches the refs it shows in its Actions section, but it is still a compact subset rather than a full target dump.
- Use `bp text` for readable copy.
- On noisy pages, scope `bp text` with `--selector main` or another container.
- Use `bp review` after form submits, checkouts, or other business-state transitions.
- Do not expect `bp review` to be a great first read on dense catalog, search, or marketing pages with lots of nav chrome.
- `bp targets` marks the session tab with `current: true`; `attached: true` does not mean current.
- Use `bp use-target <target-id>` to bind the session to an exact tab.
- Use `bp eval` only as an escape hatch after higher-level commands are insufficient.
- For longer probes, save JavaScript to a temporary file and run `bp eval -f /tmp/bp-probe.js`.
  Add `--script` when the file is an async function body containing top-level `await` or `return`.

Likely next steps:

- `bp exec -s dev '[...]'`
- `bp text -s dev --selector '#main'`
- `bp diagnose -s dev '<selector>'`

## WebMCP

Use WebMCP when the page exposes structured tools through `document.modelContext`:

```bash
bp webmcp status -s dev
bp webmcp list -s dev --json
bp webmcp call addTodo --input '{"text":"Buy milk"}' --confirm-mutation -s dev --json
```

Discovery and invocation run in the attached document context. Tool lists are
refreshed after navigation; tools without `readOnlyHint: true` require the
explicit `--confirm-mutation` acknowledgement. See the [WebMCP guide](guides/webmcp.md)
for secure-context, origin-isolation, origin, and Permissions Policy requirements.

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

- `expectAny`, `expectAll`, `failIf`: verify the action's effect
- `dangerous`: prevent auto-retry on ambiguous outcomes

Supported condition kinds are `urlMatches`, `elementVisible`, `elementHidden`, `textAppears`,
`textChanges`, `networkResponse`, `stateSignatureChanges`, `selectedTab`, `fieldValue`,
`checkbox`, `switch`, `elementEnabled`, `targetCount`, `newTarget`, `urlChanged`, and
`fieldChanged`. Text and URL conditions support explicit match modes and scoped selectors or
landmarks.

Retries respect the dispatch boundary. A pre-dispatch failure may retry the input; after a
dispatch or uncertain result, retry attempts observe the page and re-evaluate conditions rather
than blindly sending the same input again. Set `effect` to `observe`, `idempotent`, or
`at_most_once` when you need an explicit policy.

Example:

```bash
bp exec -s dev '[
  {"action":"click","selector":"#save",
   "expectAny":[{"kind":"textAppears","text":"Saved"}],
   "dangerous":true}
]'
```

New widget actions:

- `chooseOption`: custom combobox interaction
- `upload`: file upload with verification
- `review`: structured page state extraction
- `delta`: page change detection

Likely next steps:

- `bp exec --record -f workflow.json`
- `bp trace summary -s dev --view console`
- `bp diagnose -s dev '<selector>'`

Hydration caveat:

- `waitFor: "networkIdle"` only means the page went transport-quiet.
- On hydrated apps, follow navigation with `bp snapshot -i`, `bp text`, `bp review`, or an explicit assertion before you trust the state.

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
bp connect --name demo
bp record -s demo --profile automation -f ./artifacts/demo.recording.json
# perform the flow, then stop with Ctrl+C
bp record summary ./artifacts/demo.recording.json
bp record inspect ./artifacts/demo.recording.json
bp record derive ./artifacts/demo.recording.json -o ./artifacts/demo.workflow.json
jq . ./artifacts/demo.workflow.json
bp run ./artifacts/demo.workflow.json -s demo
```

Use profiles when they matter:

- `automation`
- `realtime`
- `voice`
- `auth`

Rules:

- Summary first, raw JSON later.
- `record` captures an existing named session; it does not create one.
- `record derive` writes browser-pilot workflow JSON for `bp run`. Use Flightplan for simple reusable workflows.
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
- `bp trace status`
- `bp trace stop`
- `bp trace tail`
- `bp trace summary`
- `bp trace watch`
- `bp trace export`
- `bp trace merge`

Views:

- `http` (URL, status, duration, and failure; response bodies are not captured)
- `ws`
- `voice`
- `console`
- `permissions`
- `media`
- `ui`
- `session`

Capture modes:

- `bp trace start` is foreground and **blocks** until Ctrl+C or `--timeout`.
- `bp trace start --background` (`--detach`) returns immediately. It auto-stops after 10 minutes or 100 MB
  by default, whichever comes first. Inspect it with `trace status` and stop it early with
  `trace stop`.

Non-blocking workflow:

```bash
bp trace start -s realtime --background
# reproduce the issue with bp exec, another tool, or manual browser actions
bp trace stop -s realtime
bp trace summary -s realtime --view session
bp trace summary -s realtime --view http
bp trace summary -s realtime --view ws
bp trace summary -s realtime --view console
```

Foreground workflow (this shell waits for the capture):

```bash
bp trace start -s realtime --timeout 20000
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
- Start with `--view session` when you are not yet sure which narrower channel matters.

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
- `bp env auth ...` — persisted Cloudflare-Access-style header/cookie auth,
  reapplied on every attach/reattach. See
  `docs/proposals/cloudflare-access-auth.md` for the full lifecycle
  semantics (persisted `env auth set-*` vs. ephemeral `setCookie`/`setHeaders`
  actions).

Examples:

```bash
bp env permissions grant -s dev microphone
bp env network offline -s dev --duration 5000
bp env network throttle -s dev --latency 200 --down 128kbps --up 64kbps
bp env visibility hidden -s dev
bp env geolocation set -s dev --lat 37.7749 --lon -122.4194

# Cloudflare Access auth (persisted, reapplied on every attach)
bp env auth set-headers -s dev --from-env CF-Access-Client-Id=CF_ACCESS_CLIENT_ID --from-env CF-Access-Client-Secret=CF_ACCESS_CLIENT_SECRET
bp env auth set-cookie CF_Authorization -s dev --value-from-env CF_ACCESS_JWT --domain example.com
bp env auth clear -s dev

# Sugar: mint the CF_Authorization cookie automatically (cookie mode, default)
bp connect --new-tab --page-url https://app.example.com --cf-access
bp connect --new-tab --page-url https://app.example.com --cf-access --cf-access-mode headers
```

Likely next steps:

- `bp trace watch -s dev --view ws --assert profile:reconnect`
- `bp exec -s dev '[{"action":"assertPermission","name":"geolocation","state":"granted"}]'`

## Session lifecycle

Connecting to a target behind Cloudflare Access? See `--cf-access` in the [Env](#env)
section above.

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
bp daemon list --json
bp daemon stop --daemon-id <id>
```

`daemon status` and `daemon stop` verify the control socket's daemon ID and
browser fingerprint before trusting a live PID. If a registered daemon is
unresponsive, inspect the PID first and pass `--force` only when you intend to
signal it without that identity proof.

## Routing summary

- Need targets or refs: `snapshot`
- Need compact overview: `page`
- Need to act now: `exec`
- Need to replay saved steps: `run`
- Need to capture a human demo: `record`
- Need to explain behavior over time: `trace`
- Need voice/media control: `audio`
- Need browser-state manipulation: `env`
- Need page-provided tools: `webmcp`
- Need structured business state: `review`
