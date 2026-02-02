/**
 * Test harness for integration tests
 * Manages Chrome lifecycle and fixture server
 */

import * as chromeLauncher from 'chrome-launcher';
import { type Browser, connect, getBrowserWebSocketUrl, type Page } from '../../src';

export interface RecoveryOptions {
  maxAttempts?: number; // Default: 2
  retryDelay?: number; // Default: 500ms
  healthCheckTimeout?: number; // Default: 2000ms
}

export interface TestHarness {
  browser: Browser;
  baseUrl: string;
  chrome: chromeLauncher.LaunchedChrome;
  server: ReturnType<typeof Bun.serve>;
}

// Global harness - only used for single-harness mode
let globalHarness: TestHarness | null = null;

/**
 * Setup a new isolated test harness - launches Chrome and starts fixture server
 * Each call creates a new isolated instance (no singleton)
 */
export async function createTestHarness(): Promise<TestHarness> {
  // 1. Start fixture server
  const server = Bun.serve({
    port: 0, // Random available port
    async fetch(req) {
      const url = new URL(req.url);
      let pathname = url.pathname;

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
  });

  const baseUrl = `http://localhost:${server.port}`;
  console.log(`  Fixture server started at ${baseUrl}`);

  // 2. Launch Chrome with debugging
  const chrome = await chromeLauncher.launch({
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
    ],
    // Don't use default profile
    userDataDir: false,
  });

  console.log(`  Chrome launched on port ${chrome.port}`);

  // 3. Connect browser-pilot
  const wsUrl = await getBrowserWebSocketUrl(`localhost:${chrome.port}`);
  const browser = await connect({
    provider: 'generic',
    wsUrl,
    debug: false,
  });

  console.log('  Browser connected');

  return { browser, baseUrl, chrome, server };
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

/**
 * Check if Chrome is healthy by pinging its /json/version endpoint
 * Fast check (~100ms typical), returns boolean
 */
export async function isChromeHealthy(port: number, timeoutMs = 2000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`http://localhost:${port}/json/version`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Recover a harness by killing the old Chrome instance and launching a new one
 * Mutates the harness in-place (critical - fileHarness is module-level variable)
 */
export async function recoverHarness(
  harness: TestHarness,
  options: RecoveryOptions = {}
): Promise<TestHarness> {
  const { maxAttempts = 2, retryDelay = 500, healthCheckTimeout = 2000 } = options;

  console.log('[HARNESS] Chrome appears dead, attempting recovery...');

  // Kill the old Chrome instance
  try {
    await harness.chrome.kill();
  } catch {
    // Ignore kill errors - Chrome may already be dead
  }

  // Try to close the browser connection gracefully
  try {
    await harness.browser.close();
  } catch {
    // Ignore close errors
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`[HARNESS] Recovery attempt ${attempt}/${maxAttempts}`);

    try {
      // Launch new Chrome
      const chrome = await chromeLauncher.launch({
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
        ],
        userDataDir: false,
      });

      console.log(`[HARNESS] New Chrome launched on port ${chrome.port}`);

      // Verify Chrome is healthy before connecting
      const healthy = await isChromeHealthy(chrome.port, healthCheckTimeout);
      if (!healthy) {
        await chrome.kill();
        throw new Error('New Chrome instance failed health check');
      }

      // Connect browser-pilot
      const wsUrl = await getBrowserWebSocketUrl(`localhost:${chrome.port}`);
      const browser = await connect({
        provider: 'generic',
        wsUrl,
        debug: false,
      });

      console.log('[HARNESS] Browser reconnected successfully');

      // Mutate harness in-place
      harness.chrome = chrome;
      harness.browser = browser;

      return harness;
    } catch (error) {
      console.log(`[HARNESS] Recovery attempt ${attempt} failed:`, error);

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }

  throw new Error(`[HARNESS] Failed to recover Chrome after ${maxAttempts} attempts`);
}
