# Cloudflare Workers Guide

browser-pilot is designed to work in Cloudflare Workers. This guide covers deployment and best practices.

## Why Workers?

- **Edge computing** - Run close to users globally
- **Serverless** - No server management
- **Cost effective** - Pay per request
- **Fast cold starts** - Sub-millisecond startup

## Requirements

1. A Cloudflare Workers account
2. A browser provider that supports external connections:
   - [BrowserBase](https://browserbase.com) (recommended)
   - [Browserless](https://browserless.io)

**Note:** You cannot run Chrome in Workers directly. You must connect to an external browser service.

## Basic Setup

### 1. Create Worker Project

```bash
npm create cloudflare@latest my-browser-worker
cd my-browser-worker
npm install browser-pilot
```

### 2. Configure Environment

Add your API keys to `wrangler.toml`:

```toml
name = "my-browser-worker"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
# Non-sensitive config here

# Add secrets via wrangler
# wrangler secret put BROWSERBASE_API_KEY
```

Set secrets:

```bash
wrangler secret put BROWSERBASE_API_KEY
```

### 3. Write Your Worker

```typescript
// src/index.ts
import { connect } from 'browser-pilot';

interface Env {
  BROWSERBASE_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/scrape') {
      return handleScrape(request, env);
    }

    return new Response('Browser Worker', { status: 200 });
  },
};

async function handleScrape(request: Request, env: Env): Promise<Response> {
  const { targetUrl } = await request.json();

  const browser = await connect({
    provider: 'browserbase',
    apiKey: env.BROWSERBASE_API_KEY,
  });

  try {
    const page = await browser.page();
    await page.goto(targetUrl);

    const snapshot = await page.snapshot();

    return Response.json({
      url: snapshot.url,
      title: snapshot.title,
      elements: snapshot.interactiveElements.length,
    });
  } finally {
    await browser.close();
  }
}
```

### 4. Deploy

```bash
wrangler deploy
```

## Examples

### Form Submission

```typescript
async function submitForm(env: Env, formData: Record<string, string>): Promise<Response> {
  const browser = await connect({
    provider: 'browserbase',
    apiKey: env.BROWSERBASE_API_KEY,
  });

  try {
    const page = await browser.page();

    const result = await page.batch([
      { action: 'goto', url: 'https://example.com/form' },
      { action: 'fill', selector: '#name', value: formData.name },
      { action: 'fill', selector: '#email', value: formData.email },
      { action: 'fill', selector: '#message', value: formData.message },
      { action: 'submit', selector: 'form' },
      { action: 'wait', waitFor: 'navigation' },
      { action: 'snapshot' },
    ]);

    const snapshot = result.steps[6].result as PageSnapshot;

    return Response.json({
      success: result.success,
      confirmationPage: snapshot.title,
    });
  } finally {
    await browser.close();
  }
}
```

### Scheduled Scraping

```typescript
// wrangler.toml
// [triggers]
// crons = ["0 */6 * * *"]  # Every 6 hours

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(scrapeAndStore(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    // ... HTTP handler
  },
};

async function scrapeAndStore(env: Env): Promise<void> {
  const browser = await connect({
    provider: 'browserbase',
    apiKey: env.BROWSERBASE_API_KEY,
  });

  try {
    const page = await browser.page();
    await page.goto('https://news.example.com');

    const snapshot = await page.snapshot();

    // Store in KV, D1, or R2
    await env.MY_KV.put('latest-news', JSON.stringify({
      timestamp: new Date().toISOString(),
      title: snapshot.title,
      content: snapshot.text,
    }));
  } finally {
    await browser.close();
  }
}
```

### AI Agent Endpoint

```typescript
interface AgentRequest {
  sessionId?: string;
  actions: Step[];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const { sessionId, actions } = await request.json() as AgentRequest;

    // Get or create session
    let wsUrl = sessionId ? await env.SESSIONS.get(sessionId) : null;

    const browser = await connect({
      provider: 'browserbase',
      apiKey: env.BROWSERBASE_API_KEY,
      wsUrl: wsUrl ?? undefined,
    });

    try {
      const page = await browser.page();
      const result = await page.batch(actions);

      // Save session for reuse
      const newSessionId = sessionId ?? crypto.randomUUID();
      await env.SESSIONS.put(newSessionId, browser.wsUrl, {
        expirationTtl: 3600, // 1 hour
      });

      return Response.json({
        sessionId: newSessionId,
        result,
      });
    } finally {
      await browser.disconnect(); // Keep session alive
    }
  },
};
```

## Best Practices

### 1. Always Close Browsers

Use try/finally to ensure cleanup:

```typescript
const browser = await connect({ ... });
try {
  // Your code
} finally {
  await browser.close();
}
```

### 2. Use Timeouts

Workers have a 30-second limit (or longer on paid plans):

```typescript
const browser = await connect({
  provider: 'browserbase',
  apiKey: env.BROWSERBASE_API_KEY,
  timeout: 25000, // Leave buffer for cleanup
});

await page.goto(url, { timeout: 20000 });
```

### 3. Handle Errors

```typescript
try {
  const browser = await connect({ ... });
  // ...
} catch (error) {
  if (error instanceof TimeoutError) {
    return Response.json({ error: 'Request timed out' }, { status: 504 });
  }
  if (error instanceof ElementNotFoundError) {
    return Response.json({ error: 'Element not found' }, { status: 422 });
  }
  throw error;
}
```

### 4. Session Reuse

For multi-step workflows, reuse sessions:

```typescript
// Store session in KV
await env.SESSIONS.put(userId, browser.wsUrl, {
  expirationTtl: 1800, // 30 minutes
});

// Later: resume
const wsUrl = await env.SESSIONS.get(userId);
if (wsUrl) {
  const browser = await connect({
    provider: 'browserbase',
    wsUrl,
    apiKey: env.BROWSERBASE_API_KEY,
  });
}
```

### 5. Minimize Browser Time

Do heavy processing after closing the browser:

```typescript
const browser = await connect({ ... });
let snapshot;

try {
  const page = await browser.page();
  await page.goto(url);
  snapshot = await page.snapshot();
} finally {
  await browser.close();
}

// Process after browser is closed
const processed = processSnapshot(snapshot);
return Response.json(processed);
```

## Limitations

1. **No local Chrome** - Must use external browser service
2. **Connection latency** - WebSocket connection adds ~100-300ms
3. **CPU limits** - Workers have CPU time limits
4. **Memory limits** - 128MB default, 512MB on paid plans

## Cost Optimization

1. **Reuse sessions** - Avoid creating new browser sessions for each request
2. **Batch actions** - One batch call vs multiple individual calls
3. **Close promptly** - Don't leave browser sessions idle
4. **Use snapshots** - More efficient than screenshots for text content

## Debugging

### Local Development

```bash
wrangler dev
```

### Enable Tracing

```typescript
import { enableTracing } from 'browser-pilot';

enableTracing({
  output: 'callback',
  callback: (event) => console.log(JSON.stringify(event)),
});
```

### View BrowserBase Debug URL

```typescript
const browser = await connect({ provider: 'browserbase', apiKey });
console.log('Debug URL:', browser.metadata?.debugUrl);
```
