import { describe, expect, mock, test } from 'bun:test';
import { Page } from '../../src/browser/page.ts';
import type { CDPClient } from '../../src/cdp/client.ts';

describe('Page navigation timeout plumbing', () => {
  test('passes the page timeout to the Page.navigate CDP command', async () => {
    const send = mock((method: string) => {
      if (method === 'Page.navigate') return Promise.resolve({});
      return Promise.resolve({});
    });
    const cdp = {
      send,
      on: mock(() => {}),
      off: mock(() => {}),
    } as unknown as CDPClient;
    const page = new Page(cdp, 'target-1');

    // Keep this focused on the CDP command plumbing; navigation-event behavior is covered by
    // the existing wait tests and does not require a browser here.
    Object.defineProperty(page, 'waitForNavigation', {
      configurable: true,
      value: async () => true,
    });

    await page.goto('https://example.test/slow', { timeout: 120_000 });

    expect(send).toHaveBeenCalledWith(
      'Page.navigate',
      { url: 'https://example.test/slow' },
      undefined,
      { timeout: 120_000 }
    );
  });
});
