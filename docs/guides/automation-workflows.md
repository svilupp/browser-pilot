# Automation Workflows

Use this guide to choose the right Browser Pilot workflow quickly.

For simple, reusable, low-cost automation on top of browser-pilot, use the companion
[Flightplan](https://github.com/svilupp/flightplan) package when it is released.

For local Chrome on Chrome 144+, try plain `bp connect` first after enabling remote debugging in `chrome://inspect/#remote-debugging`. Only add `--channel` or `--user-data-dir` when needed to disambiguate local profiles.

## Workflow 1: inspect then act

Use when you know the app but need current targets.

```bash
bp connect --name dev
bp snapshot -i -s dev
bp exec -s dev '[
  {"action":"click","selector":"ref:e4"},
  {"action":"assertText","expect":"Saved"}
]'
```

Why:

- `snapshot -i` gives you refs
- `exec` keeps actions and assertions together

## Workflow 2: capture a manual demo and derive automation

Use when a human is showing the path.

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

`bp record derive` writes browser-pilot workflow JSON for `bp run`. Use Flightplan for simple reusable workflows.

If the workflow is stateful, add trace analysis before deriving:

```bash
bp trace summary ./artifacts/demo.recording.json --view ws
bp trace summary ./artifacts/demo.recording.json --view console
```

## Workflow 3: harden the flow with trace-backed assertions

Use when the app is realtime, voice-based, or timing-sensitive.

```bash
bp exec -s dev '[
  {"action":"waitForWsMessage","match":"*realtime*","where":{"type":"session.ready"},"timeout":5000},
  {"action":"assertTextChanged","selector":"#status","from":"Connecting","to":"Live","timeout":5000},
  {"action":"assertNoConsoleErrors","windowMs":500}
]'
```

Other useful assertions:

- `assertPermission`
- `assertMediaTrackLive`

## Workflow 4: run reusable workflows

Use when you already have stable steps.

```bash
bp run workflow.json --json
```

Then investigate failures with:

```bash
bp trace summary -s dev --view console
bp diagnose -s dev '<selector>'
```

## Workflow 5: replay with proof

Use when you want screenshots and an artifact while validating a saved flow.

```bash
bp connect --name validation --record
bp exec -s validation -f workflow.json
```

This accumulates a canonical artifact and screenshots across multiple `bp exec` calls.

## Workflow 6: exercise failure modes

Use when reconnects, degraded modes, or permission state matter.

```bash
bp trace start -s dev --timeout 20000
bp env network offline -s dev --duration 5000
bp trace watch -s dev --view ws --assert profile:reconnect --timeout 15000
```

## Routing rules

- Need page targets: `snapshot`
- Need direct control: `exec`
- Need reusable file execution: `run`
- Need capture from human behavior: `record`
- Need explanation over time: `trace`
- Need voice control: `audio`
- Need browser-state changes: `env`
