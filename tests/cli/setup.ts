/**
 * CLI test setup and utilities
 *
 * Each test file gets its own isolated harness (browser + server instance)
 * to avoid conflicts when tests run in parallel.
 */

import { $ } from 'bun';
import { createTestHarness, destroyHarness, type TestHarness } from '../utils/harness';

export interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  json?: unknown;
}

// Each CLI test file gets its own isolated harness
let fileHarness: TestHarness | null = null;

/**
 * Run the CLI with given arguments
 */
export async function runCLI(args: string[]): Promise<CLIResult> {
  const result = await $`bun ./src/cli/index.ts ${args}`.quiet().nothrow();

  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();

  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    // Not JSON output
  }

  return {
    stdout,
    stderr,
    exitCode: result.exitCode,
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
 * Get WebSocket URL for the browser
 * Fetches from Chrome's /json/version endpoint
 */
export async function getWebSocketUrl(): Promise<string> {
  if (!fileHarness) {
    throw new Error('CLI test harness not initialized. Call setup() in beforeAll.');
  }
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
