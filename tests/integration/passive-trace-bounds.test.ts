import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createTraceScript } from '../../src/trace/script.ts';
import { TestContext } from './setup.ts';

const ctx = new TestContext();
beforeAll(() => ctx.setup());
afterAll(() => ctx.teardown());
test('trace instrumentation deduplicates owners, caps retained sinks/events/payloads and restores native wrappers', async () => {
  const { page, baseUrl } = ctx.get();
  await page.goto(`${baseUrl}/basic.html`);
  await page.evaluate('globalThis.fixtureTraceSink=()=>{}');
  const original = await page.evaluate<string>('String(WebSocket)');
  await page.evaluate(createTraceScript('fixtureTraceSink', 'owner0'));
  const installed = await page.evaluate<string>('String(WebSocket)');
  await page.evaluate(createTraceScript('fixtureTraceSink', 'owner0'));
  expect(await page.evaluate<number>('window.__bpTraceHub.sinks.size')).toBe(1);
  expect(await page.evaluate<string>('String(WebSocket)')).toBe(installed);
  for (let index = 1; index < 64; index++)
    await page.evaluate(createTraceScript('fixtureTraceSink', `owner${index}`));
  const failure = await page.evaluate(createTraceScript('fixtureTraceSink', 'overflow')).then(
    () => undefined,
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(Error);
  await page.evaluate(
    "for(let i=0;i<250;i++)window.dispatchEvent(new ErrorEvent('error',{message:'x'.repeat(50000)}))"
  );
  expect(await page.evaluate<number>('window.__bpTraceHub.sinks.size')).toBe(64);
  expect(await page.evaluate<number>('globalThis.__bpTraceRecentEvents.length')).toBe(200);
  expect(
    await page.evaluate<number>(
      'Math.max(...globalThis.__bpTraceRecentEvents.map(e=>JSON.stringify(e).length))'
    )
  ).toBeLessThanOrEqual(16384);
  await page.evaluate(
    'for(const id of [...window.__bpTraceHub.sinks.keys()])window.__bpTraceHub.release(id)'
  );
  expect(await page.evaluate<string>('String(WebSocket)')).toBe(original);
  expect(await page.evaluate<boolean>('Boolean(window.__bpTraceHub)')).toBe(false);
});
