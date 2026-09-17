/**
 * Integration test for the portable cookie-snapshot auth core against real
 * Chrome: capture cookies from one browser context, restore them into a
 * fresh browser context, and confirm a cookie-gated fixture request
 * succeeds — including a `Path=/api` cookie and a parent-domain cookie.
 *
 * This file launches its own Chrome (rather than using `tests/utils/harness.ts`)
 * because it needs `--host-resolver-rules` to map a genuine two-label test
 * domain (`app.bpauth.test`) to loopback, so a real parent-domain cookie
 * (`.bpauth.test`) can be exercised — Chrome does not allow ordinary domain
 * cookies on single-label hosts like `localhost`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as chromeLauncher from 'chrome-launcher';
import { captureCookieState, restoreCookieState } from '../../src/auth/cookie-state.ts';
import { Page } from '../../src/browser/page.ts';
import { createSessionScopedCDP } from '../../src/cdp/session-scope.ts';
import { type Browser, connect, getBrowserWebSocketUrl } from '../../src/index.ts';

const APEX_HOST = 'bpauth.test';
const SUB_HOST = `app.${APEX_HOST}`;

let chrome: chromeLauncher.LaunchedChrome;
let browser: Browser;
let protectedServer: ReturnType<typeof Bun.serve>;
let baseUrl: string;

function hasCookie(header: string | null, name: string): boolean {
  if (!header) return false;
  return header.split(';').some((part) => part.trim().startsWith(`${name}=`));
}

async function getWebSocketUrlWithRetry(host: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await getBrowserWebSocketUrl(host);
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await Bun.sleep(100);
    }
  }
}

beforeAll(async () => {
  protectedServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      const cookieHeader = req.headers.get('cookie');
      if (url.pathname === '/api/protected') {
        if (!hasCookie(cookieHeader, 'api_token')) {
          return new Response('denied', { status: 401 });
        }
        return new Response('protected-ok', { status: 200 });
      }
      return new Response('root-ok', { status: 200 });
    },
  });
  baseUrl = `http://${SUB_HOST}:${protectedServer.port}`;

  chrome = await chromeLauncher.launch({
    chromeFlags: [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--mute-audio',
      '--hide-scrollbars',
      `--host-resolver-rules=MAP ${APEX_HOST} 127.0.0.1,MAP *.${APEX_HOST} 127.0.0.1`,
    ],
    userDataDir: false,
  });

  const wsUrl = await getWebSocketUrlWithRetry(`localhost:${chrome.port}`);
  browser = await connect({ provider: 'generic', wsUrl, debug: false });
});

afterAll(async () => {
  await browser.close();
  await chrome.kill();
  protectedServer.stop();
});

describe('cookie snapshot auth (real Chrome)', () => {
  test('capture in context A, restore into context B, protected request succeeds', async () => {
    const pageA = await browser.newPage(`${baseUrl}/`);

    // Host-only cookie (exact host match). Uses the page's own pinned
    // session, not the browser-level channel — `Network.setCookie` is a
    // per-session (renderer-scoped) command.
    await pageA.cdpClient.send('Network.setCookie', {
      url: `${baseUrl}/`,
      name: 'host_only_cookie',
      value: 'hv',
      path: '/',
    });
    // Parent-domain cookie: domain=".bpauth.test" must apply to "app.bpauth.test".
    await pageA.cdpClient.send('Network.setCookie', {
      url: `${baseUrl}/`,
      domain: `.${APEX_HOST}`,
      name: 'parent_cookie',
      value: 'pv',
      path: '/',
    });
    // Path-scoped cookie: only sent for /api/* requests.
    await pageA.cdpClient.send('Network.setCookie', {
      url: `${baseUrl}/api`,
      name: 'api_token',
      value: 'secret-token',
      path: '/api',
    });

    const state = await captureCookieState(pageA);
    expect(state.cookies.map((c) => c.name).sort()).toEqual(
      ['api_token', 'host_only_cookie', 'parent_cookie'].sort()
    );
    const apiCookie = state.cookies.find((c) => c.name === 'api_token');
    expect(apiCookie?.path).toBe('/api');
    const parentCookie = state.cookies.find((c) => c.name === 'parent_cookie');
    expect(parentCookie?.hostOnly).toBe(false);
    expect(parentCookie?.domain).toBe(APEX_HOST);

    // Create a fresh browser context (context B) and a blank page in it.
    const { browserContextId } = await browser.cdpClient.send<{ browserContextId: string }>(
      'Target.createBrowserContext',
      {},
      null
    );

    const { targetId } = await browser.cdpClient.send<{ targetId: string }>(
      'Target.createTarget',
      { url: 'about:blank', browserContextId, background: true },
      null
    );
    const sessionId = await browser.cdpClient.attachToTarget(targetId);
    const pageB = new Page(createSessionScopedCDP(browser.cdpClient, sessionId), targetId);
    await pageB.init();

    const result = await restoreCookieState(pageB, state);
    expect(result.restored).toBe(3);
    expect(result.skippedExpired).toBe(0);
    expect(result.unverified).toBe(0);
    expect(result.domains.sort()).toEqual([APEX_HOST, SUB_HOST].sort());

    // Protected fixture request succeeds in context B using the restored
    // path-scoped cookie.
    await pageB.goto(`${baseUrl}/api/protected`);
    const bodyText = await pageB.evaluate(() => document.body.textContent);
    expect(bodyText).toBe('protected-ok');

    // Parent-domain + host-only cookies also landed.
    const cookieJar = await pageB.evaluate(() => document.cookie);
    expect(cookieJar).toContain('host_only_cookie=hv');
    expect(cookieJar).toContain('parent_cookie=pv');
  });
});

describe('learning test: default browser context id explicit-vs-omitted (informational)', () => {
  test('documents whether Storage.getCookies accepts an explicit default context id', async () => {
    const page = await browser.newPage(`${baseUrl}/`);

    const { targetInfos } = await page.cdpClient.send<{
      targetInfos: Array<{ targetId: string; browserContextId?: string }>;
    }>('Target.getTargets', undefined, null);
    const info = targetInfos.find((t) => t.targetId === page.targetId);
    expect(info).toBeDefined();

    // Production code (resolveBrowserContextId) always OMITS the param for
    // the default context; this learning test only observes whether passing
    // it explicitly also happens to work, for documentation purposes.
    if (!info?.browserContextId) {
      console.log('[learning-test] default-context target reports no browserContextId at all');
      return;
    }

    let acceptedExplicitDefaultContextId = true;
    try {
      await page.cdpClient.send(
        'Storage.getCookies',
        { browserContextId: info.browserContextId },
        null
      );
    } catch {
      acceptedExplicitDefaultContextId = false;
    }

    console.log(
      `[learning-test] Storage.getCookies with explicit default browserContextId ` +
        `${acceptedExplicitDefaultContextId ? 'SUCCEEDED' : 'FAILED'} (informational only; ` +
        `production code always omits the param for the default context)`
    );
    // No assertion on the outcome itself — this is documentation, not a contract.
  });
});
