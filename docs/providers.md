# Providers

browser-pilot supports multiple browser providers. Choose based on your use case:

| Provider | Best For | Pros | Cons |
|----------|----------|------|------|
| Generic | Development, local testing | Free, works locally, fastest | Must manage Chrome |
| Browser Use | Production, AI agents (recommended cloud) | CAPTCHA solving, anti-detect, residential proxies in 195+ countries, live viewer | Requires account |
| BrowserBase | Production | Managed, scalable, session recording | Requires account |
| Browserless | Simple automation | Simple API, good free tier | Fewer features |

## Browser Use (Recommended Cloud Provider)

[Browser Use](https://browser-use.com) provides cloud-hosted browsers with built-in CAPTCHA solving, anti-detect fingerprinting, and residential proxies in 195+ countries. Recommended when local Chrome is not available.

### Setup

1. Create an account at [browser-use.com](https://browser-use.com)
2. Get your API key from the dashboard
3. Set `BROWSER_USE_API_KEY` in your environment

### Usage

```typescript
import { connect } from 'browser-pilot';

const browser = await connect({
  provider: 'browser-use',
  apiKey: process.env.BROWSER_USE_API_KEY,
});

// Live viewer URL is logged to stderr and available in metadata
console.log(browser.metadata?.['liveUrl']);
```

### Proxy Options

```typescript
// UK proxy (default)
const browser = await connect({
  provider: 'browser-use',
  apiKey: process.env.BROWSER_USE_API_KEY,
});

// German proxy
const browser = await connect({
  provider: 'browser-use',
  apiKey: process.env.BROWSER_USE_API_KEY,
  proxyCountryCode: 'de',
});

// No proxy
const browser = await connect({
  provider: 'browser-use',
  apiKey: process.env.BROWSER_USE_API_KEY,
  proxyCountryCode: null,
});
```

### Session Options

```typescript
const browser = await connect({
  provider: 'browser-use',
  apiKey: process.env.BROWSER_USE_API_KEY,
  proxyCountryCode: 'us',
  profileId: 'saved-profile-uuid',   // Reuse a saved browser profile
  cloudTimeout: 30,                   // Session timeout in minutes (max 240)
  session: {
    width: 1920,
    height: 1080,
  },
});
```

### Session Resumption

```typescript
const browser1 = await connect({
  provider: 'browser-use',
  apiKey: process.env.BROWSER_USE_API_KEY,
});
const sessionId = browser1.sessionId;
await browser1.disconnect();

// Later: resume
// (resumeSession is called internally when session ID is available)
```

### CLI Usage

```bash
bp connect --provider browser-use                              # UK proxy (default)
bp connect --provider browser-use --proxy-country de           # German proxy
bp connect --provider browser-use --proxy-country null         # No proxy
bp connect --provider browser-use --cloud-timeout 30           # 30-min session
bp connect --provider browser-use --profile-id <uuid>          # Saved profile
```

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

### Preferred Chrome 144+ Flow

```bash
# Start Chrome normally, then enable remote debugging in:
# chrome://inspect/#remote-debugging
bp connect
```

Tip: try plain `bp connect` first. Only add `--channel` or `--user-data-dir` if auto-discovery finds multiple eligible profiles.

### Auto-Discovery

browser-pilot can auto-discover a running local Chrome endpoint from `DevToolsActivePort`:

```typescript
import { connect } from 'browser-pilot';

// Auto-discovers from a running local Chrome profile
const browser = await connect({
  provider: 'generic',
});
```

When multiple Chrome profiles are eligible, narrow discovery:

```typescript
const betaBrowser = await connect({
  provider: 'generic',
  channel: 'beta',
});

const customBrowser = await connect({
  provider: 'generic',
  userDataDir: '/tmp/browser-pilot-profile',
});
```

CLI equivalents:

```bash
bp connect --channel beta
bp connect --user-data-dir /tmp/browser-pilot-profile
```

### Legacy Manual Debug Port Flow

Legacy/manual discovery still works when Chrome is launched with a separate debug profile:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/browser-pilot-profile \
  --no-first-run \
  --no-default-browser-check

# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/browser-pilot-profile

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%TEMP%\browser-pilot-profile

# Headless mode
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/browser-pilot-profile --headless=new
```

### Manual WebSocket URL

```typescript
import { connect, getBrowserWebSocketUrl } from 'browser-pilot';

// Get the WebSocket URL manually from a legacy /json/version endpoint
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

# Start Chrome with remote debugging and an explicit profile
CMD ["chromium-browser", \
     "--headless=new", \
     "--remote-debugging-port=9222", \
     "--remote-debugging-address=0.0.0.0", \
     "--user-data-dir=/tmp/browser-pilot-profile", \
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
  provider: 'browserbase' | 'browserless' | 'browser-use' | 'generic';
  apiKey?: string;
  wsUrl?: string;
  channel?: 'stable' | 'beta' | 'dev' | 'canary';
  userDataDir?: string;
  timeout?: number;           // Connection timeout in ms (default: 30000)
  debug?: boolean;            // Enable debug logging
  proxyCountryCode?: string | null;  // Browser Use proxy (default: 'uk')
  profileId?: string;                // Browser Use profile ID
  cloudTimeout?: number;             // Browser Use timeout in minutes
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

### Browser Use Metadata

```typescript
const browser = await connect({ provider: 'browser-use', apiKey });

// Access provider metadata
console.log(browser.metadata);
// { liveUrl: 'https://...', status: 'active', timeoutAt: '...', proxyCountryCode: 'uk' }
```

### Direct CDP Access

All providers expose the underlying CDP client:

```typescript
import { connect, getBrowserWebSocketUrl } from 'browser-pilot';

const browser = await connect({
  provider: 'generic',
  wsUrl: await getBrowserWebSocketUrl(),
});
const cdp = browser.cdpClient;

// Send raw CDP commands
await cdp.send('Network.enable');
await cdp.send('Network.setExtraHTTPHeaders', {
  headers: { 'X-Custom-Header': 'value' },
});
```
