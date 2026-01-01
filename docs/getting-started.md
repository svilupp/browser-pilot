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

Cloud providers like BrowserBase handle browser infrastructure for you:

```typescript
import { connect } from 'browser-pilot';

const browser = await connect({
  provider: 'browserbase',
  apiKey: process.env.BROWSERBASE_API_KEY,
});

const page = await browser.page();
await page.goto('https://example.com');

console.log(await page.title()); // "Example Domain"

await browser.close();
```

### Option 2: Using Local Chrome

Start Chrome with remote debugging enabled:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

Then connect:

```typescript
import { connect } from 'browser-pilot';

const browser = await connect({
  provider: 'generic',
  // Auto-discovers the WebSocket URL from localhost:9222
});

const page = await browser.page();
await page.goto('https://example.com');

await browser.close();
```

## Your First Automation

Let's automate a simple login flow:

```typescript
import { connect } from 'browser-pilot';

async function login() {
  const browser = await connect({
    provider: 'browserbase',
    apiKey: process.env.BROWSERBASE_API_KEY,
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
# Connect to a browser and create a session
bp connect --provider generic --name my-session

# Navigate to a page
bp exec -s my-session '{"action":"goto","url":"https://example.com"}'

# Get the page content
bp snapshot -s my-session --format text

# Clean up
bp close -s my-session
```

## Next Steps

- [Providers](./providers.md) - Configure BrowserBase, Browserless, or local Chrome
- [Multi-Selector Guide](./guides/multi-selector.md) - Build robust automations
- [Batch Actions](./guides/batch-actions.md) - Execute action sequences efficiently
- [API Reference](./api/page.md) - Full Page API documentation
