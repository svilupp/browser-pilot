# Trace Workflows

`trace` is the analysis surface over Browser Pilot's canonical event stream.

Use it when the question spans time, network, console, permissions, media, UI, or voice behavior.

For local Chrome on Chrome 144+, try plain `bp connect` first after enabling remote debugging in `chrome://inspect/#remote-debugging`. Only add `--channel` or `--user-data-dir` when needed to narrow auto-discovery.

## Commands

- `bp trace start`
- `bp trace status`
- `bp trace stop`
- `bp trace tail`
- `bp trace summary`
- `bp trace watch`
- `bp trace export`
- `bp trace merge`

## Views

- `http`
- `ws`
- `voice`
- `console`
- `permissions`
- `media`
- `ui`
- `session`

## Background capture workflow

```bash
bp connect --name realtime
bp trace start -s realtime --background
# reproduce the issue in the browser or with other bp commands
bp trace stop -s realtime
bp trace summary -s realtime --view http
bp trace summary -s realtime --view ws
bp trace summary -s realtime --view console
```

Background capture returns immediately and auto-stops after 10 minutes or 100 MB by default,
whichever comes first. Use `--timeout <ms>` and `--max-mb <n>` to set smaller bounds. `bp trace
status -s realtime` shows the deadline, storage cap, output path, and worker log.

## Foreground capture workflow

`start` without `--background` is intentionally blocking. It owns the terminal until Ctrl+C or
the timeout expires:

```bash
bp trace start -s realtime --timeout 20000
```

Use this form when another terminal or a human will reproduce the behavior while capture runs.

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

`http`:

- which URLs were requested?
- which requests failed or were slow?
- how long did each request take from dispatch to completion?

The HTTP view records request metadata and timing, not response bodies.

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
