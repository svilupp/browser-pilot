# Providers

browser-pilot supports multiple browser providers. Choose based on your use case:

| Provider | Best For | Pros | Cons |
|----------|----------|------|------|
| BrowserBase | Production, AI agents | Managed, scalable, session recording | Requires account |
| Browserless | Production | Simple API, good free tier | Fewer features |
| Generic | Development, testing | Free, works locally | Must manage Chrome |

## BrowserBase

[BrowserBase](https://browserbase.com) is a managed browser infrastructure service optimized for AI agents.

### Setup

1. Create an account at [browserbase.com](https://browserbase.com)
2. Get your API key from the dashboard
3. Optionally note your project ID

### Usage

```typescript
import { connect } from 'browser-pilot';

const browser = await connect({
  provider: 'browserbase',
  apiKey: process.env.BROWSERBASE_API_KEY,
  projectId: process.env.BROWSERBASE_PROJECT_ID, // optional
});
```

### Session Options

```typescript
const browser = await connect({
  provider: 'browserbase',
  apiKey: process.env.BROWSERBASE_API_KEY,
  session: {
    // Viewport size
    width: 1920,
    height: 1080,
    // Enable session recording
    recording: true,
    // Proxy configuration
    proxy: {
      server: 'http://proxy.example.com:8080',
      username: 'user',
      password: 'pass',
    },
  },
});
```

### Session Resumption

BrowserBase sessions can be resumed:

```typescript
// First connection
const browser1 = await connect({ provider: 'browserbase', apiKey });
const sessionId = browser1.sessionId;
await browser1.disconnect(); // Keep session alive

// Later: resume the session
const browser2 = await connect({
  provider: 'browserbase',
  apiKey,
  session: { sessionId },
});
```

## Browserless

[Browserless](https://browserless.io) provides browser automation as a service.

### Setup

1. Create an account at [browserless.io](https://browserless.io)
2. Get your API token

### Usage

```typescript
import { connect } from 'browser-pilot';

const browser = await connect({
  provider: 'browserless',
  apiKey: process.env.BROWSERLESS_API_KEY,
});
```

### Custom Endpoint

```typescript
const browser = await connect({
  provider: 'browserless',
  apiKey: process.env.BROWSERLESS_API_KEY,
  wsUrl: 'wss://custom.browserless.io', // optional
});
```

## Generic (Local Chrome)

Connect to any Chrome instance with remote debugging enabled.

### Start Chrome

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --no-first-run \
  --no-default-browser-check

# Linux
google-chrome --remote-debugging-port=9222

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222

# Headless mode
google-chrome --remote-debugging-port=9222 --headless=new
```

### Auto-Discovery

browser-pilot can auto-discover the WebSocket URL:

```typescript
import { connect } from 'browser-pilot';

// Auto-discovers from localhost:9222
const browser = await connect({
  provider: 'generic',
});
```

### Manual WebSocket URL

```typescript
import { connect, getBrowserWebSocketUrl } from 'browser-pilot';

// Get the WebSocket URL manually
const wsUrl = await getBrowserWebSocketUrl('localhost:9222');
console.log(wsUrl); // ws://localhost:9222/devtools/browser/...

// Connect with explicit URL
const browser = await connect({
  provider: 'generic',
  wsUrl: 'ws://localhost:9222/devtools/browser/abc123',
});
```

### Docker

```dockerfile
FROM zenika/alpine-chrome:latest

# Expose debugging port
EXPOSE 9222

# Start Chrome with remote debugging
CMD ["chromium-browser", \
     "--headless=new", \
     "--remote-debugging-port=9222", \
     "--remote-debugging-address=0.0.0.0", \
     "--no-sandbox"]
```

```typescript
const browser = await connect({
  provider: 'generic',
  wsUrl: 'ws://localhost:9222/devtools/browser/...',
});
```

## Connection Options

All providers support these common options:

```typescript
interface ConnectOptions {
  provider: 'browserbase' | 'browserless' | 'generic';
  apiKey?: string;
  wsUrl?: string;
  timeout?: number;  // Connection timeout in ms (default: 30000)
  debug?: boolean;   // Enable debug logging
}
```

## Provider-Specific Features

### BrowserBase Metadata

```typescript
const browser = await connect({ provider: 'browserbase', apiKey });

// Access provider metadata
console.log(browser.metadata);
// { debugUrl: 'https://...', liveUrl: 'https://...' }
```

### Direct CDP Access

All providers expose the underlying CDP client:

```typescript
const browser = await connect({ provider: 'generic' });
const cdp = browser.cdpClient;

// Send raw CDP commands
await cdp.send('Network.enable');
await cdp.send('Network.setExtraHTTPHeaders', {
  headers: { 'X-Custom-Header': 'value' },
});
```
