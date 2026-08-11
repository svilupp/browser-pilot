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

## Drive the protocol directly

When the message you need cannot be produced through the UI - a malformed frame, a
server turn without a mic, an event the UI has no button for - send it on the socket
the page already owns with `bp emit`. The frame carries the app's real headers,
cookies, and session token, because it is the app's own connection.

```bash
bp emit ws --list                                    # which sockets exist, and where
bp emit ws '{"type":"client.response.text","content":"hi"}' --match "*realtime*"
bp emit ws -f turn.json --await 'type=assistant.turn.start' --await-timeout 10000
```

`--await` subscribes before dispatch, so a matched reply is genuinely a response to
your frame rather than a frame that happened to be buffered. It exits non-zero when
no reply arrives, which makes it usable as an assertion in scripts.

Learn the protocol from a real frame first - don't guess the message type. Proven live
against a voice/chat commerce app on a `wire-worker` socket:

```bash
bp emit ws --list -s mysession
# OPEN       wss://wire-worker-uat....workers.dev/session/...  [main]
```

Capturing one real client-to-server frame via `bp trace`/`bp listen` showed the UI sends
`{"type":"client.response.text","content":"..."}`. The similar-looking `user.transcript` type
is a server-to-client echo; injecting it is silently ignored because the client never emits it.

```bash
bp emit ws '{"type":"client.response.text","content":"show me black shirts"}' \
  --match 'wss://wire-worker-uat*' \
  --await-match '*search_results_surfaced*' --await-timeout 30000 -s mysession
# delivered: true; correlated reply carried search results, UI rendered 12 products
```

Avoid `--await-match '*'` on chatty sockets - heartbeat frames match it too. Await a specific
field (`--await type=...`) or a narrow glob instead.

Two behaviours worth knowing, both verified against Chrome:

- A `send()` on a closed socket does not throw - the browser discards the data. So
  `delivered: true` is reported only when the frame is observed leaving via
  `Network.webSocketFrameSent`; `dispatched (unconfirmed)` means it was not.
- If several sockets are open, the command fails with the candidate list instead of
  guessing. Narrow with `--match`.

Emits are never retried automatically, and `retry` on an `emit` batch step is
rejected: a re-sent frame duplicates a server-side action.

In a batch:

```bash
bp exec -s realtime '[
  {"action":"emit","payload":{"type":"ping"},"match":"*realtime*",
   "awaitReply":{"where":{"type":"pong"},"timeout":5000}}
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
