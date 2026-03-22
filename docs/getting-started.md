# Getting Started

This guide will help you get up and running with browser-pilot in under 5 minutes.

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
import { connect } from 'browser-pilot';

const browser = await connect({
  provider: 'generic',
  // Auto-discovers a local Chrome endpoint
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

Let's automate a simple login flow:

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

  // Fill in credentials (using multi-selector for robustness)
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

## Next Steps

- [Providers](./providers.md) - Configure Browser Use, BrowserBase, Browserless, or local Chrome
- [Multi-Selector Guide](./guides/multi-selector.md) - Build robust automations
- [Batch Actions](./guides/batch-actions.md) - Execute action sequences efficiently
- [API Reference](./api/page.md) - Full Page API documentation
