# browser-pilot

Automation-first browser control over Chrome DevTools Protocol for AI agents. Version 0.1.0
supports Node.js, Bun, and Cloudflare Workers with zero production dependencies.

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
| Exercise voice and media | `audio` |
| Change browser conditions | `env` |

For multiple local Chrome profiles, use `--channel` or `--user-data-dir`. Use
`bp connect --new-tab --page-url <url>` to start from a fresh tab. New tabs stay in the background
unless `--foreground` is passed.

## Known issues

- Keyboard actions in background tabs: `type`, `press`, and `shortcut` can report success without
  changing the field. Use `fill`, or create the tab with `--foreground`:
  `bp connect --new-tab --foreground --page-url <url>`.
- Modifier shortcuts in macOS Chrome: `Control+a` and `Meta+a` may not select field text in live
  CDP sessions. Typing after them can append instead of replace. Use `fill` to replace a value.
- Native selects: `select` can emit a synthetic `change` event before the final browser event. Apps
  that reject untrusted events may observe an intermediate rejected event; the final selection is
  correct in the tested case.
- Wait result metadata: `selectorUsed` in a `wait` result can contain the selector from the previous
  action. Use the wait result and page state as the source of truth.

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

## Iframes and tabs

The action interface uses `switchFrame` and `switchToMain`:

```json
[
  {"action":"switchFrame","selector":"iframe#payment"},
  {"action":"fill","selector":"#card-number","value":"4242424242424242"},
  {"action":"switchToMain"}
]
```

The library method is `page.switchToFrame(selector)`. Cross-origin frames support `click`, `fill`,
`type`, `focus`, `press`, `shortcut`, `text`, `waitFor`, and `evaluate`. Unsupported actions fail
with a clear error. Cross-origin support requires Chrome site isolation (`--site-per-process`).

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
- [LLM contract](./docs/llms.txt)
