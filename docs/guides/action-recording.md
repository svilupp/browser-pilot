# Action Recording Guide

Use `bp record` to capture a human workflow into the canonical Browser Pilot artifact.

Use `bp exec --record` when you already have steps and want screenshot proof of replay.

For simple, reusable, low-cost automation on top of browser-pilot, use the companion
[Flightplan](https://github.com/svilupp/flightplan) package when it is released.

## The model

- `record` captures a human demonstration
- `record summary` and `record inspect` explain the artifact without opening raw JSON
- `record derive` turns the artifact into candidate workflow steps and a readiness report
- `trace summary` reads the same artifact to answer websocket, console, voice, permission, media, and session questions

## Canonical artifact

New artifacts use `version: 2` and are shaped around one source of truth:

```json
{
  "version": 2,
  "recordedAt": "2026-03-12T15:00:00.000Z",
  "session": {
    "id": "checkout-demo",
    "startUrl": "https://example.com",
    "endUrl": "https://example.com/thanks",
    "targetId": "page_123"
  },
  "recipe": {
    "steps": []
  },
  "actions": [],
  "screenshots": [],
  "trace": {
    "events": [],
    "summaries": {}
  },
  "assertions": [],
  "notes": [],
  "artifacts": {
    "recordingManifest": "recording.json",
    "screenshotDir": "screenshots/"
  }
}
```

Key rule:

- `trace.events` is the system of record
- `recipe.steps` is derived automation

## Summary-first workflow

```bash
bp connect --name demo
bp record -s demo --profile automation -f ./artifacts/demo.recording.json
# perform the flow manually, then stop with Ctrl+C
bp record summary ./artifacts/demo.recording.json
bp record inspect ./artifacts/demo.recording.json
bp trace summary ./artifacts/demo.recording.json --view ws
bp record derive ./artifacts/demo.recording.json -o ./artifacts/demo.workflow.json
jq . ./artifacts/demo.workflow.json
bp run ./artifacts/demo.workflow.json -s demo
```

Why this order works:

- `summary` tells you whether the artifact is worth deeper inspection
- `inspect` gives metadata and next commands
- `trace summary --view ...` answers focused behavior questions
- `derive` produces the reusable recipe only after the artifact is understood

## Profiles

Available profiles:

- `automation`
- `realtime`
- `voice`
- `auth`

Use the profile that matches the job so later analysis is easier.

## Deriving automation

`bp record derive` produces replayable browser-pilot JSON steps that can be run directly:

```bash
bp record derive ./artifacts/demo.recording.json -o ./artifacts/demo.workflow.json
jq . ./artifacts/demo.workflow.json
bp run ./artifacts/demo.workflow.json -s demo --json
```

`record derive` emits browser-pilot workflow JSON for `bp run`. Use Flightplan for simple reusable workflows.

Then harden the flow with trace-backed assertions if needed:

```bash
bp exec -s demo '[
  {"action":"waitForWsMessage","match":"*realtime*","where":{"type":"session.ready"}},
  {"action":"assertNoConsoleErrors","windowMs":500},
  {"action":"assertTextChanged","selector":"#status","from":"Connecting","to":"Live"}
]'
```

## Relationship to trace

The artifact is not just for replay. It is also for analysis.

Examples:

```bash
bp trace summary ./artifacts/demo.recording.json --view ws
bp trace summary ./artifacts/demo.recording.json --view console
bp trace summary ./artifacts/demo.recording.json --view voice
bp trace export ./artifacts/demo.recording.json -o trace-bundle.json
```

Use `trace` when the question is temporal or causal. Use `record derive` when the goal is automation.

## Replay proof with exec --record

If you already have a workflow and want evidence of replay, use `exec --record`:

```bash
bp connect --name validation --record
bp exec -s validation -f workflow.json
bp exec -s validation '[{"action":"assertUrl","expect":"/dashboard"}]'
```

This writes a canonical artifact plus screenshots into the session directory. Session-level recording accumulates frames across multiple `bp exec` calls.

## Redaction

Sensitive values are redacted based on the field metadata, including common password, OTP, and payment-card patterns.

Redaction applies to:

- `bp record`
- `bp exec --record`
- screenshot overlays and stored manifest values

## Common mistakes

- Opening the raw artifact first instead of using `record summary`
- Using `record` for replay proof when `exec --record` is the right tool
- Reusing a noisy session when you wanted a clean capture
- Deriving steps before checking the artifact's trace summary


## Observing an existing tab (0.7.0)

Use exact target IDs rather than URLs. Multiple tabs can share a URL, and their
unsaved state differs. `use-target` explicitly changes the named owner's target;
observation borrowing does not.

```ts
import { observeSession } from 'browser-pilot/adapters/node';
const borrowed = await observeSession({ session: 'review', targetId });
try {
  // Read through borrowed.page; install only your own scoped instrumentation.
} finally {
  await borrowed.disconnect();
}
```

This currently supports local generic CLI sessions. It skips environment replay
and minimum viewport remediation, refuses target fallback, preserves the owner's
session file, and releases only its own wrapper/transport and extra daemon
attachment. It never closes the tab or stops the daemon. The returned Page still
has automation methods: callers must enforce their own read-only policy.

## Supervised capture

```sh
bp record -s review --observe --background --segment new \
  --screenshots markers --timeout 300000 --max-mb 50 -f ./review.json --json
bp record status -s review --json
bp record marker -s review --label "before reproduction" --json
bp record stop -s review --json
```

A unique recording ID fences stop/marker requests from subsequent runs. Status
moves through starting, ready, stopping, then complete or failed. The background
command returns only after instrumentation is ready; marker requests acknowledge
queueing, and status lists processed markers with event sequence and monotonic
elapsed time. One recorder can own a named session at a time. Progress diagnostics
are on stderr; foreground JSON stdout contains the final result. Background
worker diagnostics go to the private session log. SIGINT/SIGTERM also finalize.

The default timeout is five minutes and the default retained data/image cap is
50 MiB. `--drain-timeout` bounds asynchronous event capture (default five seconds).
`recording.capture` reports scheduled/completed/failed/skipped/pending work,
drain timeout and cleanup errors; `recording.complete` states evidence completeness,
independently of whether the supervisor reached its terminal complete state.
Actions remain in the recipe when screenshot capture fails. The cap bounds
retained raw data/images, not total serialized JSON size or transport buffering.

`--segment append` preserves the earlier recipe, trace and images in the session's
latest canonical artifact. `--segment new` starts a fresh recipe. Both retain an
individual segment under the unique recording directory. Append rejects a changed
target. Appending less-sensitive evidence does not sanitize an earlier segment;
use a new metadata segment when sensitive earlier evidence must be excluded.

`--screenshots events` is the compatibility default; `markers` captures only
processed markers; `off` retains action metadata without images. Screenshot
capture uses the current viewport and never scrolls the page. `--navigation
current-document` omits future-document injection; `all` follows navigation until
stop. Stop removes the recorder's page hooks, CDP bindings and future scripts,
without disabling networking or another trace collector.

`--privacy metadata` requires response bodies and screenshots off and redacts
input values, URL query/fragment/credentials, HTTP headers/bodies, console
arguments and WebSocket payload content. Standard recording still redacts known
sensitive fields and fields inside `[data-private]`, `[data-bp-private]` and
`[data-revlet-private]`; images and arbitrary runtime messages may contain secrets.
Private selectors and element labels are omitted from the DOM event channel.

## Portable evidence and candidate replay

```sh
bp record bundle ./review.json -o ./fresh-bundle
bp record summary ./fresh-bundle/recording.json --json
bp record derive ./fresh-bundle/recording.json -o ./candidate.json --json
```

The fresh bundle directory includes canonical v2 JSON, copied screenshots with
relative paths, and a SHA-256 inventory. It remains usable after moving it and
removing the source. Missing images, traversal paths, escaping symlinks and images
over 8 MiB fail export. `-f` capture output likewise receives copied images beside
the requested artifact. `record export` writes a JSON triage envelope with embedded
image bytes and hashes; summary/inspect/derive can read its canonical artifact.
Use the directory form for tools that consume image files.

Derive writes the existing workflow Step[] format plus `.readiness.json`. These
are candidate steps: they cannot restore authentication, unsaved fields, scroll,
or the exact starting UI. Redacted inputs need authorized replacements; selectors
need current uniqueness checks; clicks/submits/keypresses can have side effects.
No capture, derive, summary, bundle or export command automatically replays steps.
