# browser-pilot Documentation

Lightweight CDP-based browser automation for AI agents.

## Quick Links

- [Getting Started](./getting-started.md) - Installation and first steps
- [Providers](./providers.md) - BrowserBase, Browserless, and local Chrome
- [CLI Reference](./cli.md) - Command-line interface

## Guides

- [Multi-Selector](./guides/multi-selector.md) - Build robust automations with fallback selectors
- [Batch Actions](./guides/batch-actions.md) - Execute action sequences efficiently
- [Snapshots](./guides/snapshots.md) - AI-optimized page state extraction
- [Cloudflare Workers](./guides/cloudflare-workers.md) - Deploy to the edge

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
| Full CLI | Perfect for AI agent tool calls |

## Supported Runtimes

- Node.js 18+
- Bun
- Cloudflare Workers
- Deno (with Node compatibility)

## Providers

| Provider | Setup | Best For |
|----------|-------|----------|
| [BrowserBase](./providers.md#browserbase) | API key | Production, AI agents |
| [Browserless](./providers.md#browserless) | API key | Simple automation |
| [Generic](./providers.md#generic-local-chrome) | Local Chrome | Development, testing |

## Example

```typescript
import { connect } from 'browser-pilot';

const browser = await connect({
  provider: 'browserbase',
  apiKey: process.env.BROWSERBASE_API_KEY,
});

const page = await browser.page();

// Multi-selector for robustness
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
bp connect --provider browserbase --name my-session

# Execute actions
bp exec -s my-session '[
  {"action":"goto","url":"https://example.com"},
  {"action":"snapshot"}
]'

# Get page state
bp snapshot -s my-session --format text
```
