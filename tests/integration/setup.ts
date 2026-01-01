/**
 * Integration test context factory
 *
 * Each test file should create its own TestContext instance to get
 * an isolated harness (browser + server) that doesn't conflict with
 * other test files running in parallel.
 *
 * Usage in test files:
 *   const ctx = new TestContext();
 *   beforeAll(() => ctx.setup());
 *   afterAll(() => ctx.teardown());
 *   test('example', async () => {
 *     const { page, baseUrl } = ctx.get();
 *     await page.goto(`${baseUrl}/page.html`);
 *   });
 */

import type { Page } from '../../src';
import { createTestHarness, destroyHarness, type TestHarness } from '../utils/harness';
import { type RetryOptions, withRetry } from '../utils/retry';
import { captureFailureScreenshot } from '../utils/screenshots';

/**
 * Test context class - each test file creates its own instance
 */
export class TestContext {
  private harness: TestHarness | null = null;
  private page: Page | null = null;
  private testName: string = '';

  /**
   * Initialize the test harness (call in beforeAll)
   */
  async setup(): Promise<TestHarness> {
    console.log('\n  Setting up integration test harness...');
    this.harness = await createTestHarness();
    this.page = await this.harness.browser.page();
    return this.harness;
  }

  /**
   * Cleanup the test harness (call in afterAll)
   */
  async teardown(): Promise<void> {
    if (this.harness) {
      await destroyHarness(this.harness);
      this.harness = null;
    }
    this.page = null;
  }

  /**
   * Get the page and baseUrl for tests
   */
  get(): { page: Page; baseUrl: string } {
    if (!this.page || !this.harness) {
      throw new Error('Test harness not initialized. Call setup() in beforeAll.');
    }
    return { page: this.page, baseUrl: this.harness.baseUrl };
  }

  /**
   * Set current test name (for screenshot naming)
   */
  setTestName(name: string): void {
    this.testName = name;
  }

  /**
   * Capture failure screenshot
   */
  async captureFailure(error: Error): Promise<void> {
    if (this.page) {
      await captureFailureScreenshot(this.page, this.testName, error);
    }
  }

  /**
   * Reset page state between tests for clean isolation
   * Call this in afterEach to prevent state bleeding between tests
   */
  async resetPage(): Promise<void> {
    if (this.page) {
      await this.page.reset();
    }
  }
}

// Legacy exports for backward compatibility (deprecated)
// These use a shared instance and may cause issues in parallel tests
const legacyContext = new TestContext();

export async function setup() {
  return legacyContext.setup();
}

export async function teardown() {
  return legacyContext.teardown();
}

export function getTestContext() {
  return legacyContext.get();
}

export function getBaseUrl(): string {
  return legacyContext.get().baseUrl;
}

export function shouldSkipTests(): boolean {
  try {
    legacyContext.get();
    return false;
  } catch {
    return true;
  }
}

export function integrationTest(
  testFn: (ctx: { page: Page; baseUrl: string }) => Promise<void>,
  options?: RetryOptions
): () => Promise<void> {
  return async () => {
    const ctx = legacyContext.get();
    try {
      await withRetry(async () => {
        await testFn(ctx);
      }, options);
    } catch (error) {
      if (error instanceof Error) {
        await legacyContext.captureFailure(error);
      }
      throw error;
    }
  };
}

export function setTestName(name: string) {
  legacyContext.setTestName(name);
}
