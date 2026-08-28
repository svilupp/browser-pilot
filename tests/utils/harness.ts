/**
 * Test harness for integration tests
 * Manages Chrome lifecycle and fixture server
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as chromeLauncher from 'chrome-launcher';
import {
  type Browser,
  type ChromeChannel,
  connect,
  getBrowserWebSocketUrl,
  type Page,
  resolveChromeUserDataDirs,
} from '../../src/index.ts';

interface CreateTestHarnessOptions {
  chromePath?: string;
  port?: number;
  userDataDir?: string | false;
  discoveryEnv?: Record<string, string>;
  cleanupPaths?: string[];
}

export interface TestHarness {
  browser: Browser;
  baseUrl: string;
  chrome: chromeLauncher.LaunchedChrome;
  server: ReturnType<typeof Bun.serve>;
  userDataDir?: string;
  devToolsActivePortFile?: string;
  discoveryEnv?: Record<string, string>;
  homeDir?: string;
  cleanupPaths?: string[];
}

// Global harness - only used for single-harness mode
let globalHarness: TestHarness | null = null;

function resolveChromePath(): string | undefined {
  return process.env['BROWSER_PILOT_CHROME_PATH'] ?? process.env['CHROME_PATH'];
}

function buildDiscoveryEnv(homeDir: string): Record<string, string> {
  return {
    HOME: homeDir,
    USERPROFILE: homeDir,
    LOCALAPPDATA: join(homeDir, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    CHROME_CONFIG_HOME: join(homeDir, '.config'),
  };
}

async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      await stat(path);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }

  throw new Error(`Timed out waiting for file: ${path}`);
}

async function ensureDevToolsActivePortFile(filePath: string, browserHost: string): Promise<void> {
  try {
    await waitForFile(filePath, 1000);
    return;
  } catch {
    const wsUrl = await getBrowserWebSocketUrl(browserHost);
    const parsed = new URL(wsUrl);
    const port = parsed.port;
    const path = parsed.pathname;
    await writeFile(filePath, `${port}\n${path}\n`);
  }
}

/**
 * Setup a new isolated test harness - launches Chrome and starts fixture server
 * Each call creates a new isolated instance (no singleton)
 */
export async function createTestHarness(
  options: CreateTestHarnessOptions = {}
): Promise<TestHarness> {
  // 1. Start fixture server
  const server = Bun.serve<{ name: string }, never>({
    port: 0, // Random available port
    async fetch(req, srv) {
      const url = new URL(req.url);
      let pathname = url.pathname;

      // WebSocket echo endpoint for emit/listen fixtures. The echo carries the
      // socket's name so a test can prove WHICH socket a frame went out on.
      if (pathname === '/ws-echo') {
        if (srv.upgrade(req, { data: { name: url.searchParams.get('name') ?? 'default' } })) {
          return undefined as unknown as Response;
        }
        return new Response('Upgrade failed', { status: 400 });
      }

      // Default to index.html for directories
      if (pathname.endsWith('/')) {
        pathname += 'index.html';
      }

      // Handle root
      if (pathname === '/') {
        pathname = '/basic.html';
      }

      const filePath = `./tests/fixtures/pages${pathname}`;
      const file = Bun.file(filePath);

      if (await file.exists()) {
        const contentType = getContentType(pathname);
        return new Response(file, {
          headers: { 'Content-Type': contentType },
        });
      }

      return new Response('Not Found', { status: 404 });
    },
    websocket: {
      message(ws, message) {
        const { name } = ws.data;
        if (typeof message === 'string') {
          ws.send(JSON.stringify({ from: name, echo: message }));
        } else {
          ws.send(JSON.stringify({ from: name, binaryBytes: message.byteLength }));
        }
      },
    },
  });

  const baseUrl = `http://localhost:${server.port}`;
  console.log(`  Fixture server started at ${baseUrl}`);

  // 2. Launch Chrome with debugging
  const chromePath = options.chromePath ?? resolveChromePath();
  const userDataDir = options.userDataDir === false ? false : options.userDataDir;
  const chrome = await chromeLauncher.launch({
    chromePath,
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
      ...(process.env['BROWSER_PILOT_NATIVE_WEBMCP'] === '1'
        ? ['--enable-features=WebMCPTesting']
        : []),
    ],
    port: options.port,
    userDataDir: userDataDir ?? false,
  });

  console.log(`  Chrome launched on port ${chrome.port}`);

  const devToolsActivePortFile = userDataDir ? join(userDataDir, 'DevToolsActivePort') : undefined;
  if (devToolsActivePortFile) {
    await ensureDevToolsActivePortFile(devToolsActivePortFile, `localhost:${chrome.port}`);
  }

  // 3. Connect browser-pilot
  const wsUrl = await getBrowserWebSocketUrl(`localhost:${chrome.port}`);
  const browser = await connect({
    provider: 'generic',
    wsUrl,
    debug: false,
  });

  console.log('  Browser connected');

  return {
    browser,
    baseUrl,
    chrome,
    server,
    userDataDir: userDataDir === false ? undefined : userDataDir,
    devToolsActivePortFile,
    discoveryEnv: options.discoveryEnv,
    homeDir: options.discoveryEnv?.['HOME'],
    cleanupPaths: options.cleanupPaths,
  };
}

export async function createAutoConnectHarness(
  channel: ChromeChannel = 'stable'
): Promise<TestHarness> {
  const homeDir = await mkdtemp(join(tmpdir(), 'browser-pilot-autoconnect-'));
  const discoveryEnv = buildDiscoveryEnv(homeDir);
  const userDataDirs = resolveChromeUserDataDirs({
    platform: process.platform,
    env: discoveryEnv,
    homeDir,
  });
  const userDataDir = userDataDirs[channel];

  await mkdir(userDataDir, { recursive: true });

  return createTestHarness({
    userDataDir,
    discoveryEnv,
    cleanupPaths: [homeDir],
  });
}

/**
 * Setup the test harness (singleton mode for backward compatibility)
 * Use createTestHarness() for isolated instances
 */
export async function setupTestHarness(): Promise<TestHarness> {
  if (globalHarness) return globalHarness;
  globalHarness = await createTestHarness();
  return globalHarness;
}

/**
 * Destroy a specific harness instance
 */
export async function destroyHarness(h: TestHarness): Promise<void> {
  console.log('  Tearing down test harness...');

  try {
    await h.browser.close();
  } catch {
    // Ignore close errors
  }

  await h.chrome.kill();
  h.server.stop();

  for (const path of h.cleanupPaths ?? []) {
    await rm(path, { recursive: true, force: true });
  }
}

/**
 * Teardown the global test harness (singleton mode)
 */
export async function teardownTestHarness(): Promise<void> {
  if (!globalHarness) return;
  await destroyHarness(globalHarness);
  globalHarness = null;
}

/**
 * Get the current global test harness
 */
export function getHarness(): TestHarness {
  if (!globalHarness) {
    throw new Error('Test harness not initialized. Call setupTestHarness() first.');
  }
  return globalHarness;
}

/**
 * Check if global harness is initialized
 */
export function isHarnessReady(): boolean {
  return globalHarness !== null;
}

/**
 * Get a fresh page for each test
 */
export async function getFreshPage(): Promise<{ page: Page; baseUrl: string }> {
  const { browser, baseUrl } = getHarness();
  const page = await browser.newPage();
  return { page, baseUrl };
}

/**
 * Get content type from file extension
 */
function getContentType(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}
