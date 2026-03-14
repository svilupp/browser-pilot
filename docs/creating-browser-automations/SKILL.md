---
name: creating-browser-automations
description: Record browser workflows and convert them into reliable automation. Use this when the workflow is demonstrated manually, when you need a reusable artifact, or when you need to derive replayable steps and inspect the same artifact's runtime behavior.
---

# Creating Browser Automations

This skill is for the manual-demo-to-automation pipeline.

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
bp record -s demo --profile automation -f ./artifacts/demo.recording.json
# perform the flow manually, then stop with Ctrl+C
```

Use a profile that matches the job:

- `automation`
- `realtime`
- `voice`
- `auth`

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
bp record derive ./artifacts/demo.recording.json -o workflow.json
bp run workflow.json --json
```

## Harden the automation

Add trace-backed assertions where the app is stateful:

```bash
bp exec -s demo '[
  {"action":"waitForWsMessage","match":"*realtime*","where":{"type":"session.ready"}},
  {"action":"assertTextChanged","selector":"#status","from":"Connecting","to":"Live"},
  {"action":"assertNoConsoleErrors","windowMs":500}
]'
```

Or capture replay proof:

```bash
bp connect --name validation --record
bp exec -s validation -f workflow.json
```

## When to reach for other surfaces

- Need fresh targets on a page: `bp snapshot -i`
- Need one-off direct control: `bp exec`
- Need long-running analysis or evidence: `bp trace`
- Need voice/media control: `bp audio`
- Need permissions/network/visibility changes: `bp env`
