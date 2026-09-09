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
const browser2 = await connect({
  provider: 'browser-use',
  apiKey: process.env.BROWSER_USE_API_KEY,
  session: { sessionId },
});
```

### Cleanup

`browser.close()` returns `released` when Browser Use confirms the session is
stopped, or `already_released` when it no longer exists. HTTP failures, network
errors, and unconfirmed stops return `cleanup_pending`; retry `close()` to finish
cleanup. Provider error messages include the operation and HTTP status, without
raw response bodies.

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

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `BROWSERBASE_API_KEY` | Yes (or pass `apiKey`) | Read as a fallback when `apiKey` is omitted. |
| `BROWSERBASE_PROJECT_ID` | No | Resolved through `GET /v1/projects` when omitted; requires exactly one project. Set it explicitly for accounts with multiple projects. |

The CLI accepts the same fallback: `bp connect --provider browserbase` picks up
`BROWSERBASE_API_KEY` / `BROWSERBASE_PROJECT_ID` from the environment (including
a loaded `.env` file) when `--api-key` / `--project-id` are not passed.

### Usage

```typescript
import { connect } from 'browser-pilot';

const browser = await connect({
  provider: 'browserbase',
  apiKey: process.env.BROWSERBASE_API_KEY,
  projectId: process.env.BROWSERBASE_PROJECT_ID, // optional for accounts with one project
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

Portable options map to Browserbase's schema: `recording` sets
`browserSettings.recordSession`, and `proxy` becomes one external `proxies` entry.
Use either `proxy` or native `proxies`, not both. `width`/`height` and `recording`
override the corresponding nested settings. Native fields such as
`browserSettings.context`, `proxies`, `extensionId`, and `userMetadata` are
forwarded; Browserbase validates provider-specific fields. `timeout` is in seconds
and must be an integer from 60 to 21600. Omitting it uses the project's default.

### Session Resumption

BrowserBase sessions can be resumed:

```typescript
// First connection: keepAlive permits disconnecting and resuming until expiry.
const browser1 = await connect({
  provider: 'browserbase', apiKey, session: { keepAlive: true, timeout: 300 },
});
const sessionId = browser1.sessionId;
await browser1.disconnect(); // Keep session alive

// Later: resume the session
const browser2 = await connect({
  provider: 'browserbase',
  apiKey,
  session: { sessionId },
});
```

### `disconnect()` vs `close()`

The CLI and `InProcessSessionOwner` request `keepAlive: true` automatically.
Browserbase requires a [paid plan for keep-alive](https://docs.browserbase.com/platform/browser/long-sessions/overview).
Direct library connections use the session options you provide.

- `browser.disconnect()` detaches the CDP WebSocket. A session created with
  `keepAlive: true` remains available until provider expiry. Without keep-alive,
  Browserbase can end the session on disconnection.
- `browser.close()` **releases** the underlying session. It sends
  `POST /v1/sessions/:id { status: 'REQUEST_RELEASE' }` and polls until the
  session reaches a terminal state, then resolves with a status:

  ```typescript
  const result = await browser.close();
  // result may be undefined for providers with no meaningful release outcome.
  // result?.status: 'released' | 'cleanup_pending' | 'already_released'
  ```

  - `'released'`: the provider reported a terminal state within the cleanup budget.
  - `'cleanup_pending'`: release failed or a terminal state was not confirmed
    within the cleanup budget. Inspect `error`; the session may still be running.
    A later `close()` retries release and polling.
  - `'already_released'`: the release or polling endpoint returned HTTP 404/410.
    This is an absent-session response, not an observed terminal status.

  Prefer `close()` over `disconnect()` whenever you are done with a session
  and want BrowserBase to stop billing for it.

To release an owned session after disconnecting, use
`new BrowserBaseProvider({ apiKey, projectId }).releaseSession(sessionId)`.
It returns the same release statuses without opening a CDP connection.

### Injecting a pre-created session (`providerSession`)

Use this API inside a trusted host when session allocation and browser work are
handled by different components. The session includes a connection URL that may
contain credentials and grants direct browser access. Keep it in the trusted host.

```typescript
import { BrowserBaseProvider, connect } from 'browser-pilot';

const provider = new BrowserBaseProvider({
  apiKey,
  requestTimeoutMs: 30_000, // Includes response body consumption.
  releaseTimeoutMs: 10_000, // Total budget for release POST and polling.
});
const providerSession = await provider.createSession({ timeout: 300 });
const browser = await connect({ provider: 'browserbase', providerSession });
try {
  const page = await browser.page();
  await page.goto('https://example.com');
} finally {
  const cleanup = await browser.close();
  if (cleanup?.status === 'cleanup_pending') {
    // Retain cleanup.sessionId for reconciliation, or retry browser.close().
  }
}
```

`connect()` takes responsibility for closing an injected session, including on
connection failure. A failed connection to a newly created session also attempts
release. A failed resume leaves the existing session available to its owner.
If cleanup cannot be confirmed during startup, the thrown error identifies the
session and cleanup status.

Concurrent closes share one provider release attempt. Confirmed results are
cached; failed or pending cleanup can be retried. Session creation is never
retried automatically after a timeout because the provider may have allocated it.

For an untrusted shell or Worker RPC boundary, keep Browser, the connection URL,
and the release callback in a trusted owner. See
[Embedding boundaries](./guides/cloudflare-workers.md#embedding-boundaries).

## Browserless

[Browserless](https://browserless.io) provides browser automation as a service.

The built-in provider supports a single continuous library connection. The CLI
and `InProcessSessionOwner` reject its launch URLs because reconnecting starts a
new browser. Hosts that need separate connections must manage a
[Browserless reconnection endpoint](https://docs.browserless.io/examples/reconnect)
and its lifetime through a custom owner.

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
await cdp.send('Network.getCookies');
```

For extra HTTP headers, prefer the first-class `page.setExtraHTTPHeaders()` over
`cdp.send('Network.setExtraHTTPHeaders', ...)` directly — see
[Page API](./api/page.md#setextrahttpheadersheaders). It's the same underlying CDP call,
just documented, and it's what `bp connect --cf-access` / `bp env auth set-headers` build on.
