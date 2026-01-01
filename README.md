# browser-pilot

[![Docs](https://img.shields.io/badge/docs-API%20Reference-blue?style=flat&logo=gitbook&logoColor=white)](https://svilupp.github.io/browser-pilot/)
[![npm version](https://img.shields.io/npm/v/browser-pilot.svg)](https://www.npmjs.com/package/browser-pilot)
[![CI status](https://github.com/svilupp/browser-pilot/workflows/CI/badge.svg)](https://github.com/svilupp/browser-pilot/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/npm/l/browser-pilot.svg)](https://github.com/svilupp/browser-pilot/blob/main/LICENSE)

Lightweight CDP-based browser automation for AI agents. Zero dependencies, works in Node.js, Bun, and Cloudflare Workers.

```typescript
import { connect } from 'browser-pilot';

const browser = await connect({ provider: 'browserbase', apiKey: process.env.BROWSERBASE_API_KEY });
const page = await browser.page();

await page.goto('https://example.com/login');
await page.fill(['#email', 'input[type=email]'], 'user@example.com');
await page.fill(['#password', 'input[type=password]'], 'secret');
await page.submit(['#login-btn', 'button[type=submit]']);

const snapshot = await page.snapshot();
console.log(snapshot.text); // Accessibility tree as text

await browser.close();
```

## Why browser-pilot?

| Problem with Playwright/Puppeteer | browser-pilot Solution |
|-----------------------------------|------------------------|
| Won't run in Cloudflare Workers | Pure Web Standard APIs, zero Node.js dependencies |
| Bun CDP connection bugs | Custom CDP client that works everywhere |
| Single-selector API (fragile) | Multi-selector by default: `['#primary', '.fallback']` |
| No action batching (high latency) | Batch DSL: one call for entire sequences |
| No AI-optimized snapshots | Built-in accessibility tree extraction |

## Installation

```bash
bun add browser-pilot
# or
npm install browser-pilot
```

## Providers

### BrowserBase (Recommended for production)

```typescript
const browser = await connect({
  provider: 'browserbase',
  apiKey: process.env.BROWSERBASE_API_KEY,
  projectId: process.env.BROWSERBASE_PROJECT_ID, // optional
});
```

### Browserless

```typescript
const browser = await connect({
  provider: 'browserless',
  apiKey: process.env.BROWSERLESS_API_KEY,
});
```

### Generic (Local Chrome)

```bash
# Start Chrome with remote debugging
chrome --remote-debugging-port=9222
```

```typescript
const browser = await connect({
  provider: 'generic',
  wsUrl: 'ws://localhost:9222/devtools/browser/...', // optional, auto-discovers
});
```

## Core Concepts

### Multi-Selector (Robust Automation)

Every action accepts `string | string[]`. When given an array, tries each selector in order until one works:

```typescript
// Tries #submit first, falls back to alternatives
await page.click(['#submit', 'button[type=submit]', '.submit-btn']);

// Cookie consent - try multiple common patterns
await page.click([
  '#accept-cookies',
  '.cookie-accept',
  'button:has-text("Accept")',
  '[data-testid="cookie-accept"]'
], { optional: true, timeout: 3000 });
```

### Built-in Waiting

Every action automatically waits for the element to be visible before interacting:

```typescript
// No separate waitFor needed - this waits automatically
await page.click('.dynamic-button', { timeout: 5000 });

// Explicit waiting when needed
await page.waitFor('.loading', { state: 'hidden' });
await page.waitForNavigation();
await page.waitForNetworkIdle();
```

### Batch Actions

Execute multiple actions in a single call with full result tracking:

```typescript
const result = await page.batch([
  { action: 'goto', url: 'https://example.com/login' },
  { action: 'fill', selector: '#email', value: 'user@example.com' },
  { action: 'fill', selector: '#password', value: 'secret' },
  { action: 'submit', selector: '#login-btn' },
  { action: 'wait', waitFor: 'navigation' },
  { action: 'snapshot' },
]);

console.log(result.success); // true if all steps succeeded
console.log(result.totalDurationMs); // total execution time
console.log(result.steps[5].result); // snapshot from step 5
```

### AI-Optimized Snapshots

Get the page state in a format perfect for LLMs:

```typescript
const snapshot = await page.snapshot();

// Structured accessibility tree
console.log(snapshot.accessibilityTree);

// Interactive elements with refs
console.log(snapshot.interactiveElements);
// [{ ref: 'e1', role: 'button', name: 'Submit', selector: '...' }, ...]

// Text representation for LLMs
console.log(snapshot.text);
// - main [ref=e1]
//   - heading "Welcome" [ref=e2]
//   - button "Get Started" [ref=e3]
//   - textbox [ref=e4] placeholder="Email"
```

### Ref-Based Selectors

After taking a snapshot, use element refs directly as selectors:

```typescript
const snapshot = await page.snapshot();
// Output shows: button "Submit" [ref=e4]

// Click using the ref - no fragile CSS needed
await page.click('ref:e4');

// Fill input by ref
await page.fill('ref:e23', 'hello@example.com');

// Combine ref with CSS fallbacks
await page.click(['ref:e4', '#submit', 'button[type=submit]']);
```

Refs are stable until page navigation. Always take a fresh snapshot after navigating.

## Page API

### Navigation

```typescript
await page.goto(url, options?)
await page.reload(options?)
await page.goBack(options?)
await page.goForward(options?)

const url = await page.url()
const title = await page.title()
```

### Actions

All actions accept `string | string[]` for selectors:

```typescript
await page.click(selector, options?)
await page.fill(selector, value, options?)      // clears first by default
await page.type(selector, text, options?)       // types character by character
await page.select(selector, value, options?)    // native <select>
await page.select({ trigger, option, value, match }, options?)  // custom dropdown
await page.check(selector, options?)
await page.uncheck(selector, options?)
await page.submit(selector, options?)           // tries Enter, then click
await page.press(key)
await page.focus(selector, options?)
await page.hover(selector, options?)
await page.scroll(selector, options?)
```

### Waiting

```typescript
await page.waitFor(selector, { state: 'visible' | 'hidden' | 'attached' | 'detached' })
await page.waitForNavigation(options?)
await page.waitForNetworkIdle({ idleTime: 500 })
```

### Content

```typescript
const snapshot = await page.snapshot()
const text = await page.text(selector?)
const screenshot = await page.screenshot({ format: 'png', fullPage: true })
const result = await page.evaluate(() => document.title)
```

### Files

```typescript
await page.setInputFiles(selector, [{ name: 'file.pdf', mimeType: 'application/pdf', buffer: data }])
const download = await page.waitForDownload(() => page.click('#download-btn'))
```

### Emulation

```typescript
import { devices } from 'browser-pilot';

await page.emulate(devices['iPhone 14']);     // Full device emulation
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
await page.setUserAgent('Custom UA');
await page.setGeolocation({ latitude: 37.7749, longitude: -122.4194 });
await page.setTimezone('America/New_York');
await page.setLocale('fr-FR');
```

Devices: `iPhone 14`, `iPhone 14 Pro Max`, `Pixel 7`, `iPad Pro 11`, `Desktop Chrome`, `Desktop Firefox`

### Request Interception

```typescript
// Block images and fonts
await page.blockResources(['Image', 'Font']);

// Mock API responses
await page.route('**/api/users', { status: 200, body: { users: [] } });

// Full control
await page.intercept('*api*', async (request, actions) => {
  if (request.url.includes('blocked')) await actions.fail();
  else await actions.continue({ headers: { ...request.headers, 'X-Custom': 'value' } });
});
```

### Cookies & Storage

```typescript
// Cookies
const cookies = await page.cookies();
await page.setCookie({ name: 'session', value: 'abc', domain: '.example.com' });
await page.clearCookies();

// localStorage / sessionStorage
await page.setLocalStorage('key', 'value');
const value = await page.getLocalStorage('key');
await page.clearLocalStorage();
```

### Console & Dialogs

```typescript
// Capture console messages
await page.onConsole((msg) => console.log(`[${msg.type}] ${msg.text}`));

// Handle dialogs (alert, confirm, prompt)
await page.onDialog(async (dialog) => {
  if (dialog.type === 'confirm') await dialog.accept();
  else await dialog.dismiss();
});

// Collect messages during an action
const { result, messages } = await page.collectConsole(async () => {
  return await page.click('#button');
});
```

**Important:** Native browser dialogs (`alert()`, `confirm()`, `prompt()`) block all CDP commands until handled. Always set up a dialog handler before triggering actions that may show dialogs.

### Iframes

Switch context to interact with iframe content:

```typescript
// Switch to iframe
await page.switchToFrame('iframe#payment');

// Now actions target the iframe
await page.fill('#card-number', '4242424242424242');
await page.fill('#expiry', '12/25');

// Switch back to main document
await page.switchToMain();
await page.click('#submit-order');
```

Note: Cross-origin iframes cannot be accessed due to browser security.

### Options

```typescript
interface ActionOptions {
  timeout?: number;   // default: 30000ms
  optional?: boolean; // return false instead of throwing on failure
}
```

## CLI

The CLI provides session persistence for interactive workflows:

```bash
# Connect to a browser
bp connect --provider browserbase --name my-session
bp connect --provider generic  # auto-discovers local Chrome

# Execute actions
bp exec -s my-session '{"action":"goto","url":"https://example.com"}'
bp exec -s my-session '[
  {"action":"fill","selector":"#search","value":"browser automation"},
  {"action":"submit","selector":"#search-form"}
]'

# Get page state (note the refs in output)
bp snapshot -s my-session --format text
# Output: button "Submit" [ref=e4], textbox "Email" [ref=e5], ...

# Use refs from snapshot for reliable targeting
bp exec -s my-session '{"action":"click","selector":"ref:e4"}'
bp exec -s my-session '{"action":"fill","selector":"ref:e5","value":"test@example.com"}'

# Handle native dialogs (alert/confirm/prompt)
bp exec --dialog accept '{"action":"click","selector":"#delete-btn"}'

# Other commands
bp text -s my-session --selector ".main-content"
bp screenshot -s my-session --output page.png
bp list                    # list all sessions
bp close -s my-session     # close session
bp actions                 # show complete action reference
```

### CLI for AI Agents

The CLI is designed for AI agent tool calls. The recommended workflow:

1. **Take snapshot** to see the page structure with refs
2. **Use refs** (`ref:e4`) for reliable element targeting
3. **Batch actions** to reduce round trips

```bash
# Step 1: Get page state with refs
bp snapshot --format text
# Output shows: button "Add to Cart" [ref=e12], textbox "Search" [ref=e5]

# Step 2: Use refs to interact (stable, no CSS guessing)
bp exec '[
  {"action":"fill","selector":"ref:e5","value":"laptop"},
  {"action":"click","selector":"ref:e12"},
  {"action":"snapshot"}
]' --output json
```

Multi-selector fallbacks for robustness:
```bash
bp exec '[
  {"action":"click","selector":["ref:e4","#submit","button[type=submit]"]}
]'
```

Output:
```json
{
  "success": true,
  "steps": [
    {"action": "fill", "success": true, "durationMs": 30},
    {"action": "click", "success": true, "durationMs": 50, "selectorUsed": "ref:e12"},
    {"action": "snapshot", "success": true, "durationMs": 100, "result": "..."}
  ],
  "totalDurationMs": 180
}
```

Run `bp actions` for complete action reference.

## Examples

### Login Flow with Error Handling

```typescript
const result = await page.batch([
  { action: 'goto', url: 'https://app.example.com/login' },
  { action: 'fill', selector: ['#email', 'input[name=email]'], value: email },
  { action: 'fill', selector: ['#password', 'input[name=password]'], value: password },
  { action: 'click', selector: '.remember-me', optional: true },
  { action: 'submit', selector: ['#login', 'button[type=submit]'] },
], { onFail: 'stop' });

if (!result.success) {
  console.error(`Failed at step ${result.stoppedAtIndex}: ${result.steps[result.stoppedAtIndex!].error}`);
}
```

### Custom Dropdown

```typescript
// Using the custom select config
await page.select({
  trigger: '.country-dropdown',
  option: '.dropdown-option',
  value: 'United States',
  match: 'text',  // or 'contains' or 'value'
});

// Or compose from primitives
await page.click('.country-dropdown');
await page.fill('.dropdown-search', 'United');
await page.click('.dropdown-option:has-text("United States")');
```

### Cloudflare Workers

```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const browser = await connect({
      provider: 'browserbase',
      apiKey: env.BROWSERBASE_API_KEY,
    });

    const page = await browser.page();
    await page.goto('https://example.com');
    const snapshot = await page.snapshot();

    await browser.close();

    return Response.json({ title: snapshot.title, elements: snapshot.interactiveElements });
  },
};
```

### AI Agent Tool Definition

```typescript
const browserTool = {
  name: 'browser_action',
  description: 'Execute browser actions and get page state',
  parameters: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            action: { enum: ['goto', 'click', 'fill', 'submit', 'snapshot'] },
            selector: { type: ['string', 'array'] },
            value: { type: 'string' },
            url: { type: 'string' },
          },
        },
      },
    },
  },
  execute: async ({ actions }) => {
    const page = await getOrCreatePage();
    return page.batch(actions);
  },
};
```

## Advanced

### Direct CDP Access

```typescript
const browser = await connect({ provider: 'generic' });
const cdp = browser.cdpClient;

// Send any CDP command
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 375,
  height: 812,
  deviceScaleFactor: 3,
  mobile: true,
});
```

### Tracing

```typescript
import { enableTracing } from 'browser-pilot';

enableTracing({ output: 'console' });
// [info] goto https://example.com ✓ (1200ms)
// [info] click #submit ✓ (50ms)
```

## AI Agent Integration

browser-pilot is designed for AI agents. Two resources for agent setup:

- **[llms.txt](./docs/llms.txt)** - Abbreviated reference for LLM context windows
- **[Claude Code Skill](./docs/skill/SKILL.md)** - Full skill for Claude Code agents

To use with Claude Code, copy `docs/skill/` to your project or reference it in your agent's context.

## Documentation

See the [docs](./docs) folder for detailed documentation:

- [Getting Started](./docs/getting-started.md)
- [Providers](./docs/providers.md)
- [Multi-Selector Guide](./docs/guides/multi-selector.md)
- [Batch Actions](./docs/guides/batch-actions.md)
- [Snapshots](./docs/guides/snapshots.md)
- [CLI Reference](./docs/cli.md)
- [API Reference](./docs/api/page.md)

## License

MIT
