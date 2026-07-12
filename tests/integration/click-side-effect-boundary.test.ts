/**
 * Real-Chrome regression test for navigation after a dispatched click.
 * This test intentionally has no generic retry wrapper: a second click would
 * be visible in the server-side counter.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { TestContext } from './setup.ts';

const ctx = new TestContext();
let server: ReturnType<typeof Bun.serve> | undefined;
let effectCount = 0;

function pageHtml(destination: boolean): string {
  return `<!doctype html>
    <html><body>
      <button id="effect" type="button" onclick="fetch('/effect', { method: 'POST' }).then(() => { location.href = '/destination'; })">
        ${destination ? 'Destination action' : 'Dispatch action'}
      </button>
    </body></html>`;
}

describe('Click side-effect boundary in Chrome', () => {
  beforeAll(async () => {
    await ctx.setup();
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/effect') {
          effectCount += 1;
          return new Response('', { status: 204 });
        }
        if (path === '/destination') {
          return new Response(pageHtml(true), {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
        return new Response(pageHtml(false), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      },
    });
  });

  afterEach(async () => {
    effectCount = 0;
    await ctx.resetPage();
  });

  afterAll(async () => {
    server?.stop(true);
    await ctx.teardown();
  });

  test('does not redispatch when navigation destroys the old execution context', async () => {
    const { page } = ctx.get();
    const url = `http://localhost:${server!.port}/start`;

    const result = await page.batch([
      { action: 'goto', url },
      { action: 'click', selector: '#effect', waitForNavigation: true, retry: 2, retryDelay: 0 },
    ]);

    expect(result.success).toBe(true);
    expect(effectCount).toBe(1);
    expect(result.steps[1]?.attempts).toBe(1);
    expect(result.steps[1]?.receipt?.retrySafe).toBe(false);
    expect(result.steps[1]?.receipt?.navigationObserved).toBe(true);
  });
});
