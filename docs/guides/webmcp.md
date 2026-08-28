# WebMCP

Browser-pilot can inspect and invoke tools exposed by the active page through
Chrome's proposed WebMCP API. The API is page-scoped: tools are discovered
again after navigation and are never cached in the daemon.

```bash
bp webmcp status -s dev
bp webmcp list -s dev --json
bp webmcp call addTodo --input '{"text":"Buy milk"}' --confirm-mutation -s dev --json
```

`document.modelContext` is experimental. Chrome 149 exposes the origin trial;
Chrome 150 and newer use the document-first API. Older preview builds may only
expose `navigator.modelContext`, which browser-pilot keeps as a compatibility
fallback. For local testing, enable
`chrome://flags/#enable-webmcp-testing` and relaunch Chrome.

A secure context, an origin-keyed agent cluster, and the `tools` Permissions
Policy are required. Do not opt out with `document.domain` or
`Origin-Agent-Cluster: ?0`. `status` reports these conditions. Cross-origin
tools must be explicitly requested with
`--from-origin`, exposed by the page, and delegated with `allow="tools"` on the
iframe.

Tools are re-listed immediately before each call and matched by both name and,
when supplied, origin. Tools without `annotations.readOnlyHint: true` require
the explicit `--confirm-mutation` acknowledgement. If several origins expose
the same name, `--origin` is required. Mutation annotations are checked again
inside the execution context to prevent a tool replacement race.

Chrome 151 accepts serialized JSON input while the current draft accepts an
object. Browser-pilot selects the API contract before invocation and never
retries a tool call. Serialized tool results are decoded when they contain
JSON. Timeouts and caller aborts propagate an `AbortSignal` on draft-compatible
browsers. Chrome 151's older two-argument implementation can stop the caller's
wait but may not cancel work the page has already begun.

Chrome remote-debugging consent is separate from WebMCP policy. Run
`bp connect` once and reuse that session so the daemon owns the single browser
WebSocket; use `--no-daemon` (or `BROWSER_PILOT_NO_DAEMON=1`) for CI.

References: [Chrome WebMCP](https://developer.chrome.com/docs/ai/webmcp),
[WebMCP draft](https://webmachinelearning.github.io/webmcp/).
