/**
 * CLI test setup and utilities
 *
 * Each test file gets its own isolated harness (browser + server instance)
 * to avoid conflicts when tests run in parallel.
 */

import {
  createTestHarness,
  destroyHarness,
  isChromeHealthy,
  recoverHarness,
  type TestHarness,
} from '../utils/harness';

export interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  json?: unknown;
}

export interface CLIOptions {
  /** Timeout in milliseconds (default: 20000) */
  timeout?: number;
}

// Each CLI test file gets its own isolated harness
let fileHarness: TestHarness | null = null;

/**
 * Run the CLI with given arguments
 *
 * Uses Bun.spawn() instead of shell template ($`...`) for reliable behavior
 * in CI environments. The shell syntax can hang in GitHub Actions.
 *
 * Includes per-command timeout (default 20s) to prevent hung commands from
 * consuming entire test timeout. On timeout, kills the process and attempts
 * Chrome health recovery for subsequent tests.
 */
export async function runCLI(args: string[], options: CLIOptions = {}): Promise<CLIResult> {
  const { timeout = 20000 } = options;

  const proc = Bun.spawn(['bun', './src/cli/index.ts', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore', // Critical: don't wait for stdin in CI
  });

  // Track if we hit the timeout
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeout);

  // Read stdout and stderr as text
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  clearTimeout(timer);

  // If we timed out, attempt Chrome recovery and throw
  if (timedOut) {
    const cmdStr = args.join(' ');
    console.error(`[CLI] Command timed out after ${timeout}ms: ${cmdStr}`);

    // Try to recover Chrome for subsequent tests
    try {
      await ensureHealthyHarness();
      console.log('[CLI] Chrome health check passed after timeout');
    } catch (recoveryError) {
      console.error('[CLI] Chrome recovery failed after timeout:', recoveryError);
    }

    throw new Error(`CLI command timed out after ${timeout}ms: bun ./src/cli/index.ts ${cmdStr}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    // Not JSON output
  }

  return {
    stdout,
    stderr,
    exitCode,
    json,
  };
}

/**
 * Initialize test harness for CLI tests
 * Creates an isolated harness for this test file
 */
export async function setup() {
  console.log('\n  Setting up CLI test harness...');
  fileHarness = await createTestHarness();
  return fileHarness;
}

/**
 * Cleanup test harness
 * Destroys only this file's isolated harness
 */
export async function teardown() {
  if (fileHarness) {
    await destroyHarness(fileHarness);
    fileHarness = null;
  }
}

/**
 * Get base URL for fixture server
 */
export function getBaseUrl(): string {
  if (!fileHarness) {
    throw new Error('CLI test harness not initialized. Call setup() in beforeAll.');
  }
  return fileHarness.baseUrl;
}

/**
 * Get Chrome debugging port
 */
export function getChromePort(): number {
  if (!fileHarness) {
    throw new Error('CLI test harness not initialized. Call setup() in beforeAll.');
  }
  return fileHarness.chrome.port;
}

/**
 * Ensures Chrome is alive, recovers if dead
 * Called automatically before operations that need Chrome
 */
export async function ensureHealthyHarness(): Promise<void> {
  if (!fileHarness) {
    throw new Error('CLI test harness not initialized. Call setup() in beforeAll.');
  }

  const healthy = await isChromeHealthy(fileHarness.chrome.port);
  if (!healthy) {
    await recoverHarness(fileHarness);
  }
}

/**
 * Get WebSocket URL for the browser
 * Fetches from Chrome's /json/version endpoint
 */
export async function getWebSocketUrl(): Promise<string> {
  if (!fileHarness) {
    throw new Error('CLI test harness not initialized. Call setup() in beforeAll.');
  }

  // Ensure Chrome is healthy before fetching WebSocket URL
  await ensureHealthyHarness();

  const port = fileHarness.chrome.port;
  const response = await fetch(`http://localhost:${port}/json/version`);
  const info = (await response.json()) as { webSocketDebuggerUrl: string };
  return info.webSocketDebuggerUrl;
}

/**
 * Generate a unique session name for tests
 */
export function generateSessionName(): string {
  return `test-session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}
