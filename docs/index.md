# browser-pilot Documentation

Lightweight CDP-based browser automation for AI agents.

For simple, reusable, low-cost automation on top of browser-pilot, use the companion
[Flightplan](https://github.com/svilupp/flightplan) package when it is released:
`bunx flightplan --help`.

## Quick Links

- [Getting Started](./getting-started.md) - Installation and first steps
- [Providers](./providers.md) - Browser Use, BrowserBase, Browserless, and local Chrome
- [CLI Reference](./cli.md) - Command-line interface

## Command chooser

- `bp snapshot -i` for actionable refs
- `bp page` for a compact overview
- `bp text` for readable copy
- `bp review` for structured business state
- `bp diagnose` for selector failures
- `bp exec` / `bp run` to act in the browser

## Guides

- [Action Recording](./guides/action-recording.md) - Record workflows and capture replay screenshot trails
- [Multi-Selector](./guides/multi-selector.md) - Build resilient automations with fallback selectors
- [Batch Actions](./guides/batch-actions.md) - Execute action sequences efficiently
- [Snapshots](./guides/snapshots.md) - AI-optimized page state extraction
- [Cloudflare Workers](./guides/cloudflare-workers.md) - Deploy to the edge
- [WebMCP](./guides/webmcp.md) - Discover and invoke page-provided tools

## API Reference

- [Browser](./api/browser.md) - Connection and session management
- [Page](./api/page.md) - Navigation, actions, and content extraction
- [Types](./api/types.md) - Complete TypeScript definitions

## Features

| Feature | Description |
|---------|-------------|
| Zero Dependencies | Pure Web Standard APIs, works everywhere |
| Multi-Selector | Every action accepts `string \| string[]` |
| Smart Waiting | Automatic visibility checks before actions |
| Batch Execution | One call for entire action sequences |
| AI Snapshots | Accessibility tree optimized for LLMs |
| Session Persistence | Resume browsing across commands |
| Replay Recording | Save `recording.json` + screenshots for replay debugging |
| WebSocket Daemon | Persistent CDP connection, ~5-15ms per command |
| WebMCP | Page-scoped tool discovery and invocation with origin and mutation checks |
| Full CLI | Routed commands for AI agent tool calls |

## Supported Runtimes

- Node.js 18+
- Bun
- Cloudflare Workers

## Providers

| Provider | Setup | Best For |
|----------|-------|----------|
| [Generic](./providers.md#generic-local-chrome) | Local Chrome | Development, testing (default) |
| [Browser Use](./providers.md#browser-use-recommended-cloud-provider) | API key | Production, AI agents (recommended cloud) |
| [BrowserBase](./providers.md#browserbase) | API key | Production |
| [Browserless](./providers.md#browserless) | API key | Simple automation |

## Example

```typescript
import { connect } from 'browser-pilot';

const browser = await connect({
  provider: 'browser-use',
  apiKey: process.env.BROWSER_USE_API_KEY,
});

const page = await browser.page();

// Multi-selector fallbacks
await page.fill(['#email', 'input[type=email]'], 'user@example.com');
await page.fill(['#password', 'input[type=password]'], 'secret');
await page.submit(['#login', 'button[type=submit]']);

// AI-optimized snapshot
const snapshot = await page.snapshot();
console.log(snapshot.text);

await browser.close();
```

## CLI Example

```bash
# Connect and create session
bp connect --provider browser-use --name my-session

# Open the page
bp exec -s my-session '{"action":"goto","url":"https://example.com"}'

# Inspect and verify
bp snapshot -i -s my-session
bp text -s my-session --selector main
bp review -s my-session --json
```
