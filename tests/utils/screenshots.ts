/**
 * Screenshot capture utilities for test debugging
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '../../src';

const SCREENSHOT_DIR = './tests/screenshots';

/**
 * Ensure screenshot directory exists
 */
export async function ensureScreenshotDir(): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
}

/**
 * Capture a screenshot on test failure with full context
 */
export async function captureFailureScreenshot(
  page: Page,
  testName: string,
  error: Error
): Promise<string | null> {
  try {
    await ensureScreenshotDir();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = testName.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 50);
    const filename = `${safeName}_${timestamp}.png`;
    const filepath = join(SCREENSHOT_DIR, filename);

    // Capture screenshot
    const screenshot = await page.screenshot({ format: 'png', fullPage: true });
    const buffer = Buffer.from(screenshot, 'base64');
    await Bun.write(filepath, buffer);

    // Also save error context as JSON
    const contextFile = filepath.replace('.png', '.json');
    let pageUrl = 'unknown';
    let pageTitle = 'unknown';

    try {
      pageUrl = await page.url();
      pageTitle = await page.title();
    } catch {
      // Page might be in bad state
    }

    const context = {
      testName,
      timestamp: new Date().toISOString(),
      url: pageUrl,
      title: pageTitle,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      screenshot: filename,
    };

    await Bun.write(contextFile, JSON.stringify(context, null, 2));

    console.log(`\n  Screenshot saved: ${filepath}`);
    return filepath;
  } catch (e) {
    console.error('  Failed to capture screenshot:', e);
    return null;
  }
}

/**
 * Enhanced error class with screenshot path
 */
export class TestFailureError extends Error {
  constructor(
    message: string,
    public readonly screenshotPath: string | null,
    public readonly pageUrl: string,
    public readonly originalError: Error
  ) {
    super(`${message}\n  Screenshot: ${screenshotPath || 'none'}\n  URL: ${pageUrl}`);
    this.name = 'TestFailureError';
    this.cause = originalError;
  }
}

/**
 * Wrapper to capture screenshot on test failure
 */
export function withScreenshotOnFailure(page: Page | (() => Promise<Page>), testName: string) {
  return (testFn: () => Promise<void>) => {
    return async () => {
      try {
        await testFn();
      } catch (error) {
        const resolvedPage = typeof page === 'function' ? await page() : page;
        if (resolvedPage && error instanceof Error) {
          await captureFailureScreenshot(resolvedPage, testName, error);
        }
        throw error;
      }
    };
  };
}
