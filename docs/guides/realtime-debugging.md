# Realtime Debugging

Use this guide for websocket apps, voice apps, dashboards, and any session where timing and causality matter.

For local Chrome on Chrome 144+, try plain `bp connect` first after enabling remote debugging in `chrome://inspect/#remote-debugging`. Only add `--channel` or `--user-data-dir` if auto-discovery is ambiguous.

## Baseline capture

```bash
bp connect --name realtime
bp trace start -s realtime --timeout 30000
# reproduce the issue
bp trace summary -s realtime --view session
bp trace summary -s realtime --view ws
bp trace summary -s realtime --view console
```

## Validate the happy path in exec

If the app exposes a stable ready message or status text, assert it directly:

```bash
bp exec -s realtime '[
  {"action":"waitForWsMessage","match":"*realtime*","where":{"type":"session.ready"},"timeout":5000},
  {"action":"assertTextChanged","selector":"#status","from":"Connecting","to":"Live","timeout":5000},
  {"action":"assertNoConsoleErrors","windowMs":500}
]'
```

## Exercise reconnect logic

```bash
bp env network offline -s realtime --duration 5000
bp trace watch -s realtime --view ws --assert profile:reconnect --timeout 15000
bp trace summary -s realtime --view ws
```

Use `trace export` if you need a shareable bundle:

```bash
bp trace export -s realtime -o trace-bundle.json
```

## Inspect browser-state causes

Permissions:

```bash
bp env permissions get -s realtime microphone
bp trace summary -s realtime --view permissions
```

Visibility:

```bash
bp env visibility hidden -s realtime
bp trace summary -s realtime --view session
bp env visibility visible -s realtime
```

Geolocation:

```bash
bp env geolocation set -s realtime --lat 37.7749 --lon -122.4194
```

## Voice and media crossover

If realtime behavior includes voice or media:

```bash
bp audio check -s realtime
bp exec -s realtime '[{"action":"assertMediaTrackLive","kind":"audio"}]'
bp trace summary -s realtime --view voice
bp trace summary -s realtime --view media
```

## Common debugging loop

1. start or tail trace
2. reproduce the issue
3. summarize by the narrowest useful view
4. use `env` to force the suspected failure mode
5. re-run `trace watch` or `trace summary`
