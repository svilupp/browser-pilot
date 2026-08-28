# browser-pilot

Automation-first browser control over Chrome DevTools Protocol for AI agents.
Supports Node.js, Bun, and Cloudflare Workers with zero production dependencies.

> Companion package: [Flightplan](https://github.com/svilupp/flightplan) provides simple,
> reusable, cheap automation on top of browser-pilot. It will be released immediately after
> browser-pilot. Start with `bunx flightplan --help` for the higher-level interface.

## Install

```bash
bun add browser-pilot
# or
npm install browser-pilot
```

## CLI quick start

On Chrome 144+, enable remote debugging at `chrome://inspect/#remote-debugging`, then connect:

```bash
bp connect --name dev
bp exec -s dev '{"action":"goto","url":"https://example.com"}'
bp snapshot -i -s dev
bp exec -s dev '[{"action":"click","selector":"ref:e4"}]'
```

Use `bp --help` to route a task by job and `bp --version` to check the CLI build.

| Job | Commands |
| --- | --- |
| Inspect page state | `snapshot`, `page`, `forms`, `text`, `targets`, `diagnose` |
| Review structured state | `review`, `delta` |
| Act in the browser | `exec`, `run` |
| Capture a human workflow | `record` |
| Analyze behavior over time | `trace` |
| Inject protocol traffic | `emit` |
| Exercise voice and media | `audio` |
| Change browser conditions | `env` |
| Discover or invoke page tools | `webmcp status`, `webmcp list`, `webmcp call` |
| Authenticate behind Cloudflare Access | `connect --cf-access`, `env auth` |

For multiple local Chrome profiles, use `--channel` or `--user-data-dir`. Use
`bp connect --new-tab --page-url <url>` to start from a fresh tab. New tabs stay in the background
unless `--foreground` is passed.

The CLI keeps a browser-scoped daemon alive so subsequent commands reuse one
remote-debugging connection (and one Chrome permission prompt). Use
`bp connect --no-daemon` for an explicit direct connection; CI should set
`BROWSER_PILOT_NO_DAEMON=1` because detached daemons are not available there.
Closing the final logical session keeps a local daemon available for reuse.
Use `bp daemon list` and `bp daemon stop --daemon-id <id>` to inspect or stop it.

WebMCP is page-scoped and experimental. Use `bp webmcp status` to check the
secure-context, origin-isolation, and `tools` Permissions Policy prerequisites,
then `bp webmcp list` or `bp webmcp call` against the active session. Chrome's
origin trial starts at version 149; local testing requires
`chrome://flags/#enable-webmcp-testing`.

## Known issue

Native `select` can emit a synthetic untrusted `change` event before the final event. Apps that
reject untrusted events may observe an intermediate rejected event; the final selection is correct.

## Library quick start

Hosted browser:

```typescript
import { connect } from 'browser-pilot';

const browser = await connect({
  provider: 'browser-use',
  apiKey: process.env.BROWSER_USE_API_KEY,
});

const page = await browser.page();
await page.batch([
  { action: 'goto', url: 'https://example.com/login' },
  { action: 'fill', selector: ['#email', 'input[type=email]'], value: 'user@example.com' },
  { action: 'submit', selector: 'form' },
  { action: 'assertUrl', expect: '/dashboard' },
]);

await browser.close();
```

Local Chrome from TypeScript:

```typescript
import { connect, getBrowserWebSocketUrl } from 'browser-pilot';

const browser = await connect({
  provider: 'generic',
  wsUrl: await getBrowserWebSocketUrl(),
});
```

## The 0.1.0 interface

- **Target-safe control:** each page keeps its own CDP session. Target selection, popups, workers,
  and cross-origin iframes are explicit and isolated.
- **Inspect before acting:** snapshots produce reusable `ref:` selectors. `page`, `forms`, `text`,
  `review`, `delta`, `resolveAll`, and `diagnose` expose progressively richer reads.
- **Verified actions:** every action can use readiness waits, assertions, outcome conditions,
  failure hints, bounded retries, and target provenance.
- **Reusable evidence:** `record` and `trace` share one version 2 artifact model. `audio` and
  `env` cover voice pipelines and browser-state failure modes.

## Record and replay

Capture a human workflow with `bp record`:

```bash
bp connect --name demo
bp record -s demo --profile automation -f ./artifacts/demo.recording.json
# perform the flow manually, then stop with Ctrl+C
bp record summary ./artifacts/demo.recording.json
bp record inspect ./artifacts/demo.recording.json
bp record derive ./artifacts/demo.recording.json -o ./artifacts/demo.workflow.json
bp run ./artifacts/demo.workflow.json -s demo
```

`record` captures an existing named session. Start with `record summary` or `record inspect`, not
the raw artifact. `record derive` produces browser-pilot workflow JSON for `bp run`; Flightplan is
the companion interface for simple reusable automation.

For proof while replaying known steps:

```bash
bp connect --name validation --record
bp exec -s validation -f ./artifacts/demo.workflow.json
```

## Drive the protocol with emit

When the UI cannot produce the message you need, send a frame on a WebSocket the page already
owns with `bp emit ws`. It travels the app's real connection, so it carries real headers, cookies,
and session tokens.

```bash
bp emit ws --list -s mysession
# OPEN       wss://worker-uat....workers.dev/session/...  [main]
bp emit ws '{"type":"client.response.text","content":"show me black shirts"}' \
  --match 'wss://worker-uat*' \
  --await-match '*search_results_surfaced*' --await-timeout 30000 -s mysession
# delivered: <socketUrl>; reply correlates to the injected turn, UI renders 12 products
```

Before injecting, capture one real client-to-server frame with `bp trace`/`bp listen` to confirm
the message type the UI actually sends - a similarly named type can be a server-to-client echo
that is silently ignored if you send it instead. Prefer `--await` on a specific field or a narrow
`--await-match` glob over `'*'`, which also matches heartbeat frames on chatty sockets.

## Iframes and tabs

The action interface uses `switchFrame` and `switchToMain`:

```json
[
  {"action":"switchFrame","selector":"iframe#payment"},
  {"action":"fill","selector":"#card-number","value":"4242424242424242"},
  {"action":"switchToMain"}
]
```

The library method is `page.switchToFrame(selector)`. Cross-origin (out-of-process, OOPIF) frames
support `click`, `fill`, `type`, `focus`, `press`, `shortcut`, `text`, `waitFor`, and `evaluate`.
Unsupported actions (`select`, `check`, `hover`, `scroll`, `snapshot`, `diagnose`, etc.) fail with a
clear error; call `switchToMain()` first. Cross-origin support requires Chrome site isolation
(`--site-per-process`).

This covers common payment-field topologies (Adyen/Stripe-style secured/tokenized card fields):

- A cross-origin iframe directly on the page.
- A same-origin iframe nested INSIDE a cross-origin iframe (e.g. Stripe Elements' controller
  frame embedding a card-field frame).
- A same-origin wrapper iframe (e.g. a checkout modal container) ABOVE a cross-origin iframe.
- `fill`/`type`/`focus` tolerate a focusable input styled with `opacity: 0` (a real bounding box is
  still required) - the technique secured card fields commonly use to keep native
  autofill/paste/IME behaviour on the real input while a styled proxy sits over it. `click` stays
  strict for these.

Not supported inside a cross-origin frame: `snapshot`, `diagnose`, `select`, `check`/`uncheck`,
`hover`, `scroll`, `forms`, and similar read/interaction helpers - call `switchToMain()` first.

## Authenticated targets (Cloudflare Access)

Connect straight through a Cloudflare-Access-protected origin using a service token, no
manual login step:

```bash
bp connect --new-tab --page-url https://app.example.com --cf-access
```

This mints a `CF_Authorization` JWT out-of-band (cookie mode, the default) and applies it
before the first navigation. From the library:

```typescript
import { connect, mintCfAccessJwt } from 'browser-pilot';

const browser = await connect({ provider: 'generic' });
const page = await browser.page();
const { cookie } = await mintCfAccessJwt({
  url: 'https://app.example.com',
  clientId: process.env.CF_ACCESS_CLIENT_ID!,
  clientSecret: process.env.CF_ACCESS_CLIENT_SECRET!,
});
await page.setCookie(cookie);
```

For persisted auth that survives reattach/daemon restarts, use `bp env auth set-cookie` /
`set-headers` (see [CLI Guide](./docs/cli.md)). Full design and lifecycle semantics:
[Cloudflare Access auth proposal](./docs/proposals/cloudflare-access-auth.md).

## Providers

Use [Browser Use](https://browser-use.com) when local Chrome is unavailable:

```bash
BROWSER_USE_API_KEY=bu_... bp connect --provider browser-use
```

See [Providers](./docs/providers.md) for BrowserBase, Browserless, local Chrome, and direct CDP
connections.

## Documentation

- [Getting Started](./docs/getting-started.md)
- [CLI Guide](./docs/cli.md)
- [Automation workflows](./docs/guides/automation-workflows.md)
- [Action recording](./docs/guides/action-recording.md)
- [Trace workflows](./docs/guides/trace-workflows.md)
- [Page API](./docs/api/page.md)
- [Browser API](./docs/api/browser.md)
- [Types](./docs/api/types.md)
- [Cloudflare Access auth proposal](./docs/proposals/cloudflare-access-auth.md)
- [LLM contract](./docs/llms.txt)
