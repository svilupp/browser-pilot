# Artifact Analysis

Browser Pilot artifacts are meant to be analyzed without opening raw JSON first.

Use this order:

1. `record summary`
2. `record inspect`
3. `trace summary --view ...`
4. `record derive`
5. `record export` or `trace export`

## Sources of artifacts

You will typically get artifacts from:

- `bp record`
- `bp exec --record`
- session-level recording via `bp connect --record`

## Summary-first workflow

```bash
bp record summary ./artifacts/demo.recording.json
bp record inspect ./artifacts/demo.recording.json
bp trace summary ./artifacts/demo.recording.json --view session
bp trace summary ./artifacts/demo.recording.json --view ws
```

## What the artifact contains

- `session`: top-level session metadata
- `recipe.steps`: derived replayable automation
- `actions`: richer action log
- `screenshots`: visual checkpoints
- `trace.events`: canonical time-ordered event stream
- `trace.summaries`: derived summaries by analysis view
- `assertions`: discovered or generated checks
- `notes`: annotations
- `artifacts`: file layout information

## When to use each command

Use `record summary` when:

- you want counts and high-level health quickly
- you need the recommended next commands

Use `record inspect` when:

- you need artifact metadata without the full raw JSON

Use `trace summary --view ws|voice|console|permissions|media|ui|session` when:

- you need a focused answer over the same artifact

Use `record derive` when:

- you are ready to produce workflow steps for `bp run`

Use `record export` when:

- you need a JSON bundle for triage or sharing

## Example analysis loop

```bash
bp record summary ./artifacts/demo.recording.json
bp trace summary ./artifacts/demo.recording.json --view console
bp trace summary ./artifacts/demo.recording.json --view ws
bp record derive ./artifacts/demo.recording.json -o workflow.json
bp run workflow.json --json
```

## Common mistakes

- opening raw JSON before the summaries
- treating `recipe.steps` as the source of truth instead of `trace.events`
- deriving automation before checking console, websocket, or voice summaries
