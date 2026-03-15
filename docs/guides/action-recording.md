# Action Recording Guide

Use `bp record` to capture a human workflow into the canonical Browser Pilot artifact.

Use `bp exec --record` when you already have steps and want screenshot proof of replay.

## The model

- `record` captures a human demonstration
- `record summary` and `record inspect` explain the artifact without opening raw JSON
- `record derive` turns the artifact into replayable workflow steps
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
bp record -s demo --profile automation -f ./artifacts/demo.recording.json
# perform the flow manually, then stop with Ctrl+C
bp record summary ./artifacts/demo.recording.json
bp record inspect ./artifacts/demo.recording.json
bp trace summary ./artifacts/demo.recording.json --view ws
bp record derive ./artifacts/demo.recording.json -o workflow.json
bp run workflow.json
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

`bp record derive` produces replayable steps that can be run directly:

```bash
bp record derive ./artifacts/demo.recording.json -o workflow.json
bp run workflow.json --json
```

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
