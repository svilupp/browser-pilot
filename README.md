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

For local Chrome:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/browser-pilot-profile
```

## Choose the command by job

| Job | Primary commands |
| --- | --- |
| Inspect page state | `snapshot`, `page`, `forms`, `text`, `targets`, `diagnose` |
| Act in the browser | `exec`, `run` |
| Capture a human demo | `record` |
| Investigate behavior over time | `trace` |
| Exercise voice/media | `audio` |
| Change browser conditions | `env` |

## Golden path 1: automate a page

```bash
bp connect --provider generic --name dev
bp snapshot -i -s dev
bp exec -s dev '[
  {"action":"fill","selector":"ref:e5","value":"user@example.com"},
  {"action":"click","selector":"ref:e7"},
  {"action":"assertText","expect":"Welcome"}
]'
```

Use `bp snapshot -i` first. Refs are the default targeting strategy.

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
bp connect --provider generic --name realtime
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
