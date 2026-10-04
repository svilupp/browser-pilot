# Cloudflare Workers guide

Use `browser-pilot/core` and `browser-pilot/adapters/workers` in Workers. These
entries use web platform APIs and explicit host ports. The native root entry
provides Node/Bun environment, filesystem and local-browser defaults.

## Browser binding

```ts
import { connect, type BrowserBinding } from 'browser-pilot/adapters/workers';

interface Env { BROWSER: BrowserBinding }

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const browser = await connect({
      provider: 'cloudflare',
      cloudflare: { binding: env.BROWSER, keepAliveMs: 60_000 },
      timeout: 20_000,
    });
    try {
      const page = await browser.page();
      await page.goto('https://example.com', { timeout: 10_000 });
      return Response.json({ title: await page.title() });
    } finally {
      const cleanup = await browser.close();
      // Retain the allocation ID for retry when cleanup.status is cleanup_pending.
    }
  },
};
```

Configure `[browser] binding = "BROWSER"` in Wrangler. The adapter uses
`acquire()`, `connectSession()`, a session-pinned upgrade Fetcher,
`closeSession()` and `getSession()`. It translates `keepAliveMs` to the binding's
`keepAlive`, as specified by the [binding API](https://developers.cloudflare.com/browser-run/reference/browser-binding-api/).
Binding mode supports Chromium; it rejects Kitesurf, token/account mixing and
undocumented `lab` selection before allocation. No provider credential is stored
in a session handle. Existing allocations are borrowed unless `takeOwnership`
is explicitly true.

## Explicit token mode

```ts
import { connect } from 'browser-pilot/adapters/workers';

const browser = await connect({
  provider: 'cloudflare',
  apiKey: env.CLOUDFLARE_API_TOKEN,
  cloudflare: { accountId: env.CLOUDFLARE_ACCOUNT_ID },
  timeout: 20_000,
});
```

Store the token as a Worker secret; supply it from the trusted host, not flow
JSON or shell arguments. Token mode can explicitly select `cloudflare:kitesurf`.
The adapter upgrades through `fetch`, calls `accept()`, decodes binary messages
and closes failed or late upgrades. It does not use the constructor WebSocket
API for authenticated upgrades. Other providers can use `connectCore()` with
`transportFactory: createWorkersTransportFactory()`.

## Reusing one physical connection

Use `ConnectionSessionOwner` from `browser-pilot/core`, supplying the Workers
`connect` function. Open a session once, then acquire and detach a lease for each
command or workflow. Detach disposes borrower listeners; release closes the
owner's socket and performs provider cleanup. The host must keep the owner alive
for the intended event scope. This is an in-process coordinator, not a durable
broker across Worker instances.

```ts
import { ConnectionSessionOwner } from 'browser-pilot/core';
import { connect } from 'browser-pilot/adapters/workers';

const owner = new ConnectionSessionOwner({ connect });
const ctx = {
  generation: 'request-identity',
  signal: request.signal,
  deadline: Date.now() + 20_000,
  clock: { now: Date.now, sleep: (ms: number) => new Promise<void>(r => setTimeout(r, ms)) },
};
const handle = await owner.open({
  provider: 'cloudflare',
  apiKey: env.CLOUDFLARE_API_TOKEN,
  cloudflare: { accountId: env.CLOUDFLARE_ACCOUNT_ID },
}, ctx);
const lease = await owner.acquire(handle, ctx);
try { await (await lease.browser.page()).title(); }
finally { await lease.detach(); }
await owner.release(handle, ctx);
```

Use the same host generation across commands. Concurrent borrows on one browser
are conservatively rejected with `session_busy`. Pass an `ArtifactSink` for PNG
bytes; text-only filesystem output is rejected. Flightplan Worker hosts inject
an acquirer through `DriverFactory` and detach the lease at run teardown.

## Validation and limits

`bun run test:runtime:workers` installs the packed candidate and runs real local
workerd with simulated CDP responses, WebSocketPair upgrades, binding doubles,
byte-safe shell artifacts and cancellation. Its compatibility date is
`2026-07-30`; it uses no `nodejs_compat`. `bun run test:runtime:flightplan` adds the
packed sibling companion and two borrowed driver lifecycles.

These tests establish local runtime compatibility. They do not establish live
Cloudflare browser behavior or payment support. The binding path has documented
contracts and local validation; live service validation remains a separate gate.
See [validation evidence](../cloudflare-validation.md).

Set explicit operation budgets and allow time for cleanup. Worker CPU, request
lifetime and memory limits depend on execution context and plan; consult the
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
for the host configuration. Do not infer a universal 30-second request limit.
No deployment is required by the local portability tests.

## Frame/action sequences through shell leases

Use `bp run <handle-json> '<steps-json>'` to keep frame selection and its actions
inside one lease. It requires read, action and evaluate capabilities. Use
`bp screenshot` separately so PNG bytes go through the host ArtifactSink.
Detaching each command leaves the owner connection open. A whole-browser lease
rejects simultaneous acquisition with `session_busy`.

Document capability probes belong on disposable fixtures. Record observed
results through `page.capabilities.record(name, evidence, page.documentGeneration)`;
absent evidence remains unknown. Route/document changes invalidate these entries.
See [validation status](../cloudflare-validation.md) for the runtime and live gates.
