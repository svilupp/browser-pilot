# Browser API Reference

The `Browser` class manages the connection to a browser instance.

## Connecting

### connect(options)

Connect to a browser instance.

```typescript
import { connect } from 'browser-pilot';

const browser = await connect({
  provider: 'browserbase',
  apiKey: process.env.BROWSERBASE_API_KEY,
});
```

**Options:**

```typescript
interface ConnectOptions {
  // Required
  provider: 'browserbase' | 'browserless' | 'generic';

  // Provider-specific
  apiKey?: string;        // For browserbase, browserless
  projectId?: string;     // For browserbase
  wsUrl?: string;         // For generic, or override others

  // Session options
  session?: {
    width?: number;       // Viewport width
    height?: number;      // Viewport height
    recording?: boolean;  // Enable recording (browserbase)
    proxy?: {
      server: string;
      username?: string;
      password?: string;
    };
  };

  // Connection options
  timeout?: number;       // Connection timeout in ms
  debug?: boolean;        // Enable debug logging
}
```

**Returns:** `Promise<Browser>`

## Browser Methods

### page(name?)

Get or create a page by name.

```typescript
const page = await browser.page();           // Default page
const page = await browser.page('main');     // Named page
const page = await browser.page('checkout'); // Another named page
```

If the page doesn't exist, it's created. If it exists, the cached instance is returned.

**Returns:** `Promise<Page>`

### newPage(url?)

Create a new page (tab).

```typescript
const page = await browser.newPage();
const page = await browser.newPage('https://example.com');
```

**Returns:** `Promise<Page>`

### closePage(name)

Close a page by name.

```typescript
await browser.closePage('checkout');
```

### disconnect()

Disconnect from the browser but keep the provider session alive for later reconnection.

```typescript
await browser.disconnect();

// Later: reconnect using the same session
const browser2 = await connect({
  provider: 'browserbase',
  apiKey,
  wsUrl: savedWsUrl,
});
```

### close()

Close the browser session completely.

```typescript
await browser.close();
```

## Properties

### wsUrl

Get the WebSocket URL for this connection.

```typescript
console.log(browser.wsUrl);
// "wss://connect.browserbase.com/..."
```

### sessionId

Get the provider session ID (for resumption).

```typescript
const sessionId = browser.sessionId;
// Save this to resume later
```

### metadata

Get provider-specific metadata.

```typescript
console.log(browser.metadata);
// { debugUrl: "https://...", liveUrl: "https://..." }
```

### isConnected

Check if still connected.

```typescript
if (browser.isConnected) {
  await page.goto('https://example.com');
}
```

### cdpClient

Get the underlying CDP client for advanced usage.

```typescript
const cdp = browser.cdpClient;

// Send any CDP command
await cdp.send('Network.enable');
await cdp.send('Network.setExtraHTTPHeaders', {
  headers: { 'X-Custom': 'value' }
});
```

## Session Management

### Saving Sessions

```typescript
const browser = await connect({ provider: 'browserbase', apiKey });

// Save connection info for later
const sessionInfo = {
  wsUrl: browser.wsUrl,
  sessionId: browser.sessionId,
  provider: 'browserbase',
};

await browser.disconnect(); // Keep session alive

// Save to file, database, etc.
await saveSession(sessionInfo);
```

### Resuming Sessions

```typescript
// Load saved session
const sessionInfo = await loadSession();

// Reconnect
const browser = await connect({
  provider: sessionInfo.provider,
  wsUrl: sessionInfo.wsUrl,
  apiKey,
});

// Continue where you left off
const page = await browser.page();
```

## Examples

### Basic Usage

```typescript
import { connect } from 'browser-pilot';

const browser = await connect({
  provider: 'generic',
});

const page = await browser.page();
await page.goto('https://example.com');

console.log(await page.title());

await browser.close();
```

### Multiple Pages

```typescript
const browser = await connect({ provider: 'browserbase', apiKey });

const page1 = await browser.page('search');
const page2 = await browser.page('checkout');

await page1.goto('https://example.com/search');
await page2.goto('https://example.com/cart');

// Work with both pages
await page1.fill('#query', 'laptops');
await page2.click('#proceed');

await browser.close();
```

### With Session Persistence

```typescript
import { connect } from 'browser-pilot';
import { readFile, writeFile } from 'fs/promises';

const SESSION_FILE = '/tmp/browser-session.json';

async function getOrCreateBrowser() {
  try {
    // Try to resume existing session
    const data = await readFile(SESSION_FILE, 'utf-8');
    const session = JSON.parse(data);

    return await connect({
      provider: session.provider,
      wsUrl: session.wsUrl,
      apiKey: process.env.BROWSERBASE_API_KEY,
    });
  } catch {
    // Create new session
    const browser = await connect({
      provider: 'browserbase',
      apiKey: process.env.BROWSERBASE_API_KEY,
    });

    // Save for later
    await writeFile(SESSION_FILE, JSON.stringify({
      provider: 'browserbase',
      wsUrl: browser.wsUrl,
      sessionId: browser.sessionId,
    }));

    return browser;
  }
}

const browser = await getOrCreateBrowser();
const page = await browser.page();
// ...
await browser.disconnect(); // Keep session for next time
```

### Direct CDP Access

```typescript
const browser = await connect({ provider: 'generic' });
const cdp = browser.cdpClient;

// Emulate mobile device
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 375,
  height: 812,
  deviceScaleFactor: 3,
  mobile: true,
});

// Set geolocation
await cdp.send('Emulation.setGeolocationOverride', {
  latitude: 37.7749,
  longitude: -122.4194,
  accuracy: 100,
});

// Listen to CDP events
cdp.on('Network.requestWillBeSent', (params) => {
  console.log('Request:', params.request.url);
});

const page = await browser.page();
await page.goto('https://example.com');

await browser.close();
```
