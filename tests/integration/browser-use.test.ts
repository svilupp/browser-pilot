import { describe, expect, test } from 'bun:test';
import { Browser } from '../../src/index.ts';
import { getEnv } from '../../src/runtime/env.ts';

const API_KEY = getEnv('BROWSER_USE_API_KEY');

describe.skipIf(!API_KEY)('Browser Use provider (integration)', () => {
  test('connects to cloud browser with UK proxy', async () => {
    const browser = await Browser.connect({
      provider: 'browser-use',
      apiKey: API_KEY!,
      proxyCountryCode: 'uk',
    });

    expect(browser.wsUrl).toContain('browser-use.com');
    expect(browser.metadata?.['liveUrl']).toBeTruthy();

    const page = await browser.page();
    await page.goto('https://httpbin.org/ip');
    const text = await page.text();

    // Verify we got a response (proxy is working)
    expect(text).toContain('origin');

    await browser.close();
  }, 30000);

  test('live URL is accessible', async () => {
    const browser = await Browser.connect({
      provider: 'browser-use',
      apiKey: API_KEY!,
    });

    const liveUrl = browser.metadata?.['liveUrl'] as string;
    expect(liveUrl).toBeTruthy();

    // Verify the live URL is reachable
    const response = await fetch(liveUrl, { method: 'HEAD' });
    expect(response.status).toBeLessThan(400);

    await browser.close();
  }, 30000);
});
