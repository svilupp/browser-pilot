# Getting Started

This guide gets browser-pilot connected and running in a few commands.

For simple, reusable, low-cost automation on top of browser-pilot, see the companion
[Flightplan](https://github.com/svilupp/flightplan) package: `bunx flightplan --help`.

## Installation

```bash
bun add browser-pilot
# or
npm install browser-pilot
```

## Quick Start

### Option 1: Using a Cloud Provider (Recommended)

[Browser Use](https://browser-use.com) is the recommended cloud provider, with built-in CAPTCHA solving and anti-detect fingerprinting:

```typescript
import { connect } from 'browser-pilot';

const browser = await connect({
  provider: 'browser-use',
  apiKey: process.env.BROWSER_USE_API_KEY,
});

const page = await browser.page();
await page.goto('https://example.com');

console.log(await page.title()); // "Example Domain"

await browser.close();
```

### Option 2: Using Local Chrome

Preferred on Chrome 144+:

```bash
# Start Chrome normally, then enable remote debugging in:
# chrome://inspect/#remote-debugging
bp connect
```

Tip: try plain `bp connect` first. Only add `--channel` or `--user-data-dir` if more than one local Chrome profile is eligible.

Then connect:

```typescript
import { connect, getBrowserWebSocketUrl } from 'browser-pilot';

const browser = await connect({
  provider: 'generic',
  wsUrl: await getBrowserWebSocketUrl(),
});

const page = await browser.page();
await page.goto('https://example.com');

await browser.close();
```

If more than one Chrome profile is eligible, pass `channel: 'beta'` / `--channel beta` or set `userDataDir` / `--user-data-dir`.

Legacy/manual fallback still works with a separate debug profile:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/browser-pilot-profile

# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/browser-pilot-profile

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%TEMP%\browser-pilot-profile
```

## Your First Automation

Automate a simple login flow:

```typescript
import { connect } from 'browser-pilot';

async function login() {
  const browser = await connect({
    provider: 'browser-use',
    apiKey: process.env.BROWSER_USE_API_KEY,
  });

  const page = await browser.page();

  // Navigate to login page
  await page.goto('https://app.example.com/login');

  // Fill in credentials with fallback selectors
  await page.fill(['#email', 'input[type=email]', '[name=email]'], 'user@example.com');
  await page.fill(['#password', 'input[type=password]'], 'secretpassword');

  // Submit the form
  await page.submit(['#login-btn', 'button[type=submit]']);

  // Get the page state after login
  const snapshot = await page.snapshot();
  console.log('Logged in! Page title:', snapshot.title);

  await browser.close();
}

login();
```

## Using the CLI

The CLI is great for quick testing and AI agent integrations:

```bash
# Connect to a browser and create a session (spawns daemon for fast subsequent commands)
bp connect --name my-session

# Navigate to a page
bp exec -s my-session '{"action":"goto","url":"https://example.com"}'

# Find actionable refs
bp snapshot -i -s my-session

# Read page copy or verify business state
bp text -s my-session --selector main
bp review -s my-session --json

# Clean up
bp close -s my-session
```

Use `bp diagnose -s my-session '<selector>'` when targeting fails, and keep `bp eval` as a last-resort escape hatch.

### Record a manual workflow

Create the named session before recording. `bp record` captures that existing session and writes the artifact to the path passed to `-f`.

```bash
bp connect --name demo
bp record -s demo --profile automation -f ./artifacts/demo.recording.json
# perform the flow manually, then stop with Ctrl+C
bp record summary ./artifacts/demo.recording.json
bp record inspect ./artifacts/demo.recording.json
bp record derive ./artifacts/demo.recording.json -o ./artifacts/demo.workflow.json
jq . ./artifacts/demo.workflow.json
bp run ./artifacts/demo.workflow.json -s demo
```

`bp record derive` emits browser-pilot workflow JSON for `bp run`. Use the companion Flightplan
package for simple reusable workflows.

## Next Steps

- [Providers](./providers.md) - Configure Browser Use, BrowserBase, Browserless, or local Chrome
- [Multi-Selector Guide](./guides/multi-selector.md) - Build resilient automations
- [Batch Actions](./guides/batch-actions.md) - Execute action sequences efficiently
- [API Reference](./api/page.md) - Full Page API documentation
- [Flightplan](https://github.com/svilupp/flightplan) - Higher-level reusable automation
