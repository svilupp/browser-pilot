# Action Recording Guide

Capture browser workflows in two complementary ways:

- `bp record` for human-driven workflow capture into replayable JSON steps
- `bp connect --record` (or `bp exec --record`) for screenshot trails while replaying workflows

Use `bp record` when you want to create or refine an automation. Use recording when you want visual proof of what a replay actually did.

## Quick Start

### 1. Record a workflow

```bash
# Record interactions from local Chrome
bp record -f login.json

# Or record from an existing session
bp record -s my-session -f checkout.json
```

Press `Ctrl+C` to stop and save.

### 2. Replay it with a screenshot trail

The recommended approach is to enable recording at the session level:

```bash
bp connect --provider generic --name my-session --record
bp exec -s my-session --file login.json
bp exec -s my-session --file checkout.json
```

Session-level recording captures screenshots for **all** subsequent `bp exec` calls. Frames from multiple exec calls accumulate in the same `recording.json` manifest, giving you a complete visual trail across the entire session.

You can also enable recording on individual exec calls:

```bash
bp exec -s my-session --record --file login.json
```

This writes:

- `recording.json` — manifest for the replay
- `screenshots/` — one screenshot per captured step

By default the replay artifacts go into the session directory. Use `--record-dir` to write them somewhere else:

```bash
bp exec --record --record-dir ./artifacts/replay --file checkout.json
```

## What Gets Redacted

Recording redaction is driven by the field itself, not the action type.

Values are automatically replaced with `[REDACTED]` when the interacted field is marked sensitive, including:

- `type="password"`
- `type="hidden"`
- `autocomplete="current-password"`
- `autocomplete="new-password"`
- `autocomplete="one-time-code"`
- card autofill hints such as `cc-number`, `cc-csc`, `cc-exp`, `cc-exp-month`, `cc-exp-year`

The same redaction rules apply to:

- `bp record` output
- `bp exec --record` screenshot overlays
- `bp exec --record` manifest values in `recording.json`

## Replay Recording Options

### Session-level (recommended)

```bash
bp connect --record --record-format webp --record-quality 40
bp exec --file workflow.json
bp exec --file another-workflow.json   # frames append to the same manifest
```

Session-level options: `--record`, `--record-format`, `--record-quality`, `--no-highlights`.

### Per-exec

```bash
bp exec --record --record-format webp --record-quality 40 --file workflow.json
bp exec --record --no-highlights --file workflow.json
bp exec --record --record-dir ./artifacts/replay '[{"action":"click","selector":"#checkout"}]'
```

Per-exec `--record` flags override session-level settings for that call.

Options:

- `--record` — enable replay screenshots
- `--record-dir <path>` — override the output directory
- `--record-format <png|jpeg|webp>` — choose screenshot format
- `--record-quality <0-100>` — image quality for `jpeg`/`webp`
- `--no-highlights` — disable click/fill/assert overlays

## Accumulative Recording

When recording is enabled at the session level (`bp connect --record`), frames from multiple `bp exec` calls append to the same `recording.json` manifest. This is useful for multi-step workflows where you run several exec calls in sequence:

```bash
bp connect --record --name checkout-test

# Each exec call adds its frames to the same manifest
bp exec '{"action":"goto","url":"https://shop.example.com"}'
bp exec '[{"action":"fill","selector":"#search","value":"laptop"},{"action":"submit","selector":"form"}]'
bp exec '{"action":"click","selector":".product-card"}'
bp exec '[{"action":"click","selector":"#add-to-cart"},{"action":"assertText","expect":"Added"}]'

# recording.json now contains frames from all four exec calls
cat ~/.browser-pilot/sessions/checkout-test/recording.json | jq '.frames | length'
```

Recording settings (format, quality, highlights) are stored in the session metadata and persist across commands. You do not need to repeat them on each `bp exec` call.

## What the Manifest Contains

`recording.json` includes:

- session identifier
- start and end URLs
- viewport
- format and quality
- overall success flag
- one frame entry per captured step

Each frame includes:

- action name
- selector used
- redacted value when applicable
- success/failure
- timing
- screenshot filename
- page URL and page title at capture time

Even if replay stops on a failed step, browser-pilot still writes the manifest so the artifacts remain usable for debugging.

## Recommended Workflow

```bash
# 1. Record manually
bp record -f login.json

# 2. Connect with session-level recording enabled
bp connect --record --name validation

# 3. Replay and inspect machine-readable results (screenshots captured automatically)
bp exec -f login.json --json

# 4. Run additional steps — frames accumulate in the same manifest
bp exec '[{"action":"assertUrl","expect":"/dashboard"}]' --json

# 5. Inspect the captured frames
cat ~/.browser-pilot/sessions/validation/recording.json | jq '.frames[] | {action, success, screenshot, value}'
```

## Cleanup

Recorded screenshots accumulate in session directories. Trim older sessions by total disk usage:

```bash
bp clean --max-size 500MB
```

This removes the oldest sessions first and stops any attached daemons before deletion.
