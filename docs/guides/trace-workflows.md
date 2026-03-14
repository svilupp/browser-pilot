# Trace Workflows

`trace` is the analysis surface over Browser Pilot's canonical event stream.

Use it when the question spans time, network, console, permissions, media, UI, or voice behavior.

For local Chrome on Chrome 144+, try plain `bp connect` first after enabling remote debugging in `chrome://inspect/#remote-debugging`. Only add `--channel` or `--user-data-dir` when needed to narrow auto-discovery.

## Commands

- `bp trace start`
- `bp trace tail`
- `bp trace summary`
- `bp trace watch`
- `bp trace export`
- `bp trace merge`

## Views

- `ws`
- `voice`
- `console`
- `permissions`
- `media`
- `ui`
- `session`

## Live capture workflow

```bash
bp connect --name realtime
bp trace start -s realtime --timeout 20000
# reproduce the issue in the browser
bp trace summary -s realtime --view ws
bp trace summary -s realtime --view console
```

Use `tail` when you want raw live JSONL:

```bash
bp trace tail ws -s realtime -m "*realtime*"
```

## Watch workflow

Use `trace watch` for long-running assertions.

```bash
bp trace watch -s realtime --view ws --assert profile:reconnect --timeout 15000
bp trace watch -s realtime --view console --assert no-console-errors --timeout 5000
```

## Artifact workflow

Saved recordings and replay artifacts can be analyzed directly:

```bash
bp trace summary ./artifacts/demo.recording.json --view ws
bp trace summary ./artifacts/demo.recording.json --view voice
bp trace export ./artifacts/demo.recording.json -o trace-bundle.json
```

## Merge workflow

Use `merge` when you need one combined evidence file:

```bash
bp trace merge trace-a.jsonl trace-b.jsonl -o merged-trace.json
```

## Typical questions by view

`ws`:

- did the socket connect?
- what were the last frames before close?
- was the connection silent or dead?

`voice`:

- did capture start?
- was audio detected?
- was playback happening?
- was the issue permission, capture, playback, or app readiness?

`console`:

- what warnings and errors happened?
- were there uncaught exceptions or unhandled rejections?

`permissions`:

- what state did the page report?
- when did it change?

`media`:

- did tracks start or end?
- was playback active?

`ui`:

- what key text or UI state changed over time?

## Compatibility

`bp listen ...` still works, but it is now a compatibility alias to `bp trace tail ...`.
