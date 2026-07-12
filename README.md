# browser-pilot

[![Docs](https://img.shields.io/badge/docs-API%20Reference-blue?style=flat&logo=gitbook&logoColor=white)](https://svilupp.github.io/browser-pilot/)
[![npm version](https://img.shields.io/npm/v/browser-pilot.svg)](https://www.npmjs.com/package/browser-pilot)
[![CI status](https://github.com/svilupp/browser-pilot/workflows/CI/badge.svg)](https://github.com/svilupp/browser-pilot/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/npm/l/browser-pilot.svg)](https://github.com/svilupp/browser-pilot/blob/main/LICENSE)

Automation-first CDP browser control for AI agents.

Browser Pilot now teaches one workflow model:

- inspect the page
- act in the browser
- review structured business state
- record a manual workflow
- trace behavior over time
- exercise voice/media and browser conditions

`record` and `trace` are two interfaces over the same capture system. `record` writes the canonical artifact. `trace` explains either a live session or a saved artifact.

## Install

```bash
bun add browser-pilot
# or
npm install browser-pilot
```

For local Chrome on Chrome 144+:

```bash
# 1. Start Chrome normally
# 2. Open chrome://inspect/#remote-debugging
# 3. Enable remote debugging, then run:
bp connect
```

Tip: try plain `bp connect` first. Only add `--channel` or `--user-data-dir` if auto-discovery finds more than one eligible profile.

Use `bp connect --channel beta` or `bp connect --user-data-dir <path>` when more than one Chrome profile is eligible.

Legacy/manual fallback still works with a separate debug profile:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/browser-pilot-profile
```

## Choose the command by job

| Job | Primary commands |
| --- | --- |
| Inspect page state | `snapshot`, `page`, `forms`, `text`, `targets`, `diagnose` |
| Review structured state | `review` |
| Act in the browser | `exec`, `run` |
| Capture a human demo | `record` |
| Investigate behavior over time | `trace` |
| Exercise voice/media | `audio` |
| Change browser conditions | `env` |

Start with `bp --help` to see the routed command tree and `bp --version` to confirm the CLI build.

Use `bp snapshot -i` to find clickable/fillable refs, `bp text` for long-form copy, `bp review` for structured business outcomes, and `bp diagnose` when targeting fails. Use `bp eval` only as an escape hatch.

## Golden path 1: automate a page

```bash
bp connect --name dev
bp exec -s dev '{"action":"goto","url":"https://example.com"}'
bp snapshot -i -s dev
bp exec -s dev '[
  {"action":"fill","selector":"ref:e5","value":"user@example.com"},
  {"action":"click","selector":"ref:e7"},
  {"action":"assertText","expect":"Welcome"}
]'
```

Use `bp snapshot -i` first. Refs are the default targeting strategy.

For reading or verification after actions:

```bash
bp text -s dev --selector main
bp review -s dev --json
bp diagnose -s dev 'submit'
```

Best practices from real usage:

- `bp page` is a compact overview. It caches the refs it shows, but use `bp snapshot -i` when you need the full actionable list.
- On commerce and content-heavy sites, scope reading with `bp text --selector main` to avoid nav, drawers, and footer noise.
- `bp review` works best on confirmations, detail pages, tables, alerts, and key-value layouts. It is usually the wrong first read on catalog grids.
- After `bp trace start`, begin with `bp trace summary --view session` before narrower views like `console` or `ws`.

## Golden path 2: capture a manual workflow and derive automation

```bash
bp record -s demo --profile automation -f ./artifacts/demo.recording.json
# perform the flow manually, then stop with Ctrl+C
bp record summary ./artifacts/demo.recording.json
bp record derive ./artifacts/demo.recording.json -o workflow.json
bp run workflow.json
```

Do not start by opening the raw artifact. Use `record summary`, `record inspect`, or `trace summary --view ...` first.

## Golden path 3: debug a realtime or voice session

```bash
bp connect --name realtime
bp trace start -s realtime --timeout 20000
# reproduce the issue in the app
bp trace summary -s realtime --view ws
bp trace summary -s realtime --view console
```

Voice workflow:

```bash
bp audio setup -s realtime
bp exec -s realtime '{"action":"goto","url":"https://my-voice-app.com"}'
bp audio check -s realtime
bp audio roundtrip -s realtime -i prompt.wav --transcribe -o response.wav
bp trace summary -s realtime --view voice
```

## Golden path 4: exercise failure modes

```bash
bp env permissions grant -s realtime microphone
bp env network offline -s realtime --duration 5000
bp trace watch -s realtime --view ws --assert profile:reconnect --timeout 15000
bp env visibility hidden -s realtime
```

## What is new in the model

- One canonical artifact model with `version: 2`
- One canonical trace event stream for recording, live trace, and session logs
- Trace-backed waits and assertions in `exec` / `run`
- `listen` preserved as a compatibility alias to `trace tail`
- `audio` for active control, `trace` for explanation, `env` for browser-state controls

## Cloud provider

When local Chrome is not available, [Browser Use](https://browser-use.com) is the recommended cloud provider:

```bash
BROWSER_USE_API_KEY=bu_... bp connect --provider browser-use
```

```typescript
const browser = await connect({
  provider: 'browser-use',
  apiKey: process.env.BROWSER_USE_API_KEY,
});
```

See [Providers](./docs/providers.md) for BrowserBase, Browserless, and other options.

## Programmatic example

```typescript
import { connect } from 'browser-pilot';

const browser = await connect({ provider: 'generic' });
const page = await browser.page();

await page.batch([
  { action: 'goto', url: 'https://example.com/login' },
  { action: 'fill', selector: ['#email', 'input[type=email]'], value: 'user@example.com' },
  { action: 'submit', selector: 'form' },
  { action: 'assertUrl', expect: '/dashboard' },
]);

await browser.close();
```

Resolve and diagnose targets without executing anything:

```typescript
import { connect } from 'browser-pilot';

const page = await (await connect({ provider: 'generic' })).page();

// Rank every plausible target for an intent (read-only; runs no actions)
const candidates = await page.resolveAll('create order', { limit: 5 });

// Explain why a selector or intent does/doesn't resolve
const diagnosis = await page.diagnose('#submit-btn');
```

`rankCandidates`, `scoreElement`, `diagnoseElement`, and `captureStructureSignature` are also exported directly from `browser-pilot` for use against a snapshot you already hold.

## Iframes

Switch context into an iframe with `switchFrame`, then `switchToMain` to return:

```json
[
  {"action":"switchFrame","selector":"iframe#payment"},
  {"action":"fill","selector":"#card-number","value":"4242424242424242"},
  {"action":"switchToMain"},
  {"action":"click","selector":"#submit-order"}
]
```

Cross-origin (out-of-process) iframes can also be entered. Inside a cross-origin frame the supported subset is `click`, `fill`, `type`, `focus`, `press`, `shortcut`, `text`, `waitFor`, and `evaluate`; other in-frame actions (`select`, `check`, `submit`, `hover`, `scroll`, `snapshot`, `forms`, ...) hard-fail with a clear error and need `switchToMain` first. Cross-origin support requires Chrome site isolation (`--site-per-process`), and a same-origin iframe nested inside a cross-origin frame (e.g. full Stripe Elements) is not yet supported.

## Guides

- [CLI guide](./docs/cli.md)
- [Automation workflows](./docs/guides/automation-workflows.md)
- [Action recording](./docs/guides/action-recording.md)
- [Trace workflows](./docs/guides/trace-workflows.md)
- [Realtime debugging](./docs/guides/realtime-debugging.md)
- [Voice agent testing](./docs/guides/voice-agent-testing.md)
- [Artifact analysis](./docs/guides/artifact-analysis.md)
- [LLM contract](./docs/llms.txt)

## Compatibility notes

- Prefer `--debug` for transport logging. `--trace` still works as a legacy alias.
- Prefer `bp trace tail ...`. `bp listen ...` still works as a compatibility alias.
