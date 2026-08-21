---
name: creating-browser-automations
description: Record browser workflows and convert them into reliable automation. Use this when the workflow is demonstrated manually, when you need a reusable artifact, or when you need to derive replayable steps and inspect the same artifact's runtime behavior.
---

# Creating Browser Automations

This skill is for the manual-demo-to-automation pipeline.

For simple, reusable, low-cost automation on top of browser-pilot, use the companion
[Flightplan](https://github.com/svilupp/flightplan) package when it is released.

For local Chrome on Chrome 144+, try plain `bp connect` first after enabling remote debugging in `chrome://inspect/#remote-debugging`. Only add `--channel` or `--user-data-dir` if auto-discovery is ambiguous.

## Core rule

Do not start by reading raw `recording.json`.

Start with:

- `bp record summary`
- `bp record inspect`
- `bp trace summary --view ...`

## Pipeline

1. Capture the workflow with `bp record`
2. Summarize the artifact
3. Inspect runtime behavior through `trace summary`
4. Derive replayable steps
5. Run the derived workflow
6. Harden with assertions or replay proof

## Capture

```bash
bp connect --name demo
bp record -s demo --profile automation -f ./artifacts/demo.recording.json
# perform the flow manually, then stop with Ctrl+C
```

Use a profile that matches the job:

- `automation`
- `realtime`
- `voice`
- `auth`

If the target sits behind Cloudflare Access, authenticate before capturing — otherwise the
recording just captures the Access login redirect. Run `bp connect --cf-access` (or
`bp env auth set-headers`/`set-cookie` for persisted auth) before `bp record`, not as part
of the demoed flow. See `docs/proposals/cloudflare-access-auth.md`.

## Understand the artifact before deriving

```bash
bp record summary ./artifacts/demo.recording.json
bp record inspect ./artifacts/demo.recording.json
bp trace summary ./artifacts/demo.recording.json --view session
bp trace summary ./artifacts/demo.recording.json --view ws
bp trace summary ./artifacts/demo.recording.json --view console
```

Use `trace summary` to inspect network/runtime behavior inside the same artifact instead of inventing a separate debugging path.

## Derive and run

```bash
bp record derive ./artifacts/demo.recording.json -o ./artifacts/demo.workflow.json
jq . ./artifacts/demo.workflow.json
bp run ./artifacts/demo.workflow.json -s demo --json
```

`bp record derive` writes browser-pilot workflow JSON for `bp run`. Use Flightplan for simple reusable workflows.

## Harden the automation

Add trace-backed assertions where the app is stateful:

```bash
bp exec -s demo '[
  {"action":"waitForWsMessage","match":"*realtime*","where":{"type":"session.ready"}},
  {"action":"assertTextChanged","selector":"#status","from":"Connecting","to":"Live"},
  {"action":"assertNoConsoleErrors","windowMs":500}
]'
```

Add outcome conditions to verify actions actually worked:

```bash
bp exec -s demo '[
  {"action":"submit","selector":"form",
   "expectAny":[
     {"kind":"urlMatches","pattern":"*/success*"},
     {"kind":"textAppears","text":"Submitted"}
   ],
   "failIf":[{"kind":"textAppears","text":"Error"}],
   "dangerous":true}
]'
```

Conditions include `urlMatches`, `elementVisible`, `elementHidden`, `textAppears`, `textChanges`,
`networkResponse`, `stateSignatureChanges`, `selectedTab`, `fieldValue`, `checkbox`, `switch`,
`elementEnabled`, `targetCount`, `newTarget`, `urlChanged`, and `fieldChanged`. Text and URL
conditions can use explicit match modes and scoped selectors or landmarks.

For asynchronous pages, a `waitForReady` action can combine `any`/`all`, `loadingHidden`,
predicates, and DOM-stability requirements. `waitFor: "networkIdle"` only means transport quiet.

If a derived workflow uses retries, remember that retries stop at the dispatch boundary: a
pre-dispatch failure may retry the action, while a dispatched or uncertain effect is observed and
its conditions are re-evaluated instead of blindly repeating input. Use `effect` and `dangerous`
when the action's retry policy matters.

Review page state after a workflow completes:

```bash
bp review -s demo --json
```

Or capture replay proof:

```bash
bp connect --name validation --record
bp exec -s validation -f workflow.json
```

## When to reach for other surfaces

- Need fresh targets on a page: `bp snapshot -i`
- Need structured business state: `bp review`
- Need one-off direct control: `bp exec`
- Need to verify an action's effect: outcome conditions in `bp exec`
- Need long-running analysis or evidence: `bp trace`
- Need voice/media control: `bp audio`
- Need permissions/network/visibility changes: `bp env`
