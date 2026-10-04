import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Recorder } from '../../src/recording/recorder.ts';
import { LiveTraceCollector } from '../../src/trace/live.ts';
import { TestContext } from './setup.ts';

const ctx = new TestContext();
beforeAll(() => ctx.setup());
afterAll(() => ctx.teardown());
test('stop/restart and future navigation remove only recorder-owned resources', async () => {
  const { page, baseUrl } = ctx.get();
  await page.goto(`${baseUrl}/basic.html`);
  const native = await page.evaluate(() => String(window.WebSocket));
  const trace = new LiveTraceCollector(page.cdpClient);
  await trace.start();
  const recorder = new Recorder(page.cdpClient, { listen: true });
  await recorder.start();
  await page.evaluate(() =>
    document
      .querySelector('#show-dynamic')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  );
  const first = await recorder.stop();
  expect(first.steps.filter((s) => s.action === 'click')).toHaveLength(1);
  expect(first.capture?.cleanupErrors).toEqual([]);
  const count = recorder.getEvents().length;
  await page.goto(`${baseUrl}/basic.html?after-stop=1`);
  await page.evaluate(() => {
    console.error('trace consumer survives recorder stop');
    document
      .querySelector('#show-dynamic')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(recorder.getEvents()).toHaveLength(count);
  expect(
    await page.evaluate(
      () =>
        Object.keys((window as unknown as { __bpRecorders?: object }).__bpRecorders ?? {}).length
    )
  ).toBe(0);
  expect(trace.getEvents().some((e) => e.event === 'console.error')).toBe(true);
  await recorder.start();
  await page.evaluate(() =>
    document
      .querySelector('#show-dynamic')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))
  );
  const second = await recorder.stop();
  expect(second.steps.filter((s) => s.action === 'click')).toHaveLength(1);
  expect(second.capture?.cleanupErrors).toEqual([]);
  await trace.stop();
  expect(await page.evaluate(() => String(window.WebSocket))).toBe(native);
  expect(
    await page.evaluate(() =>
      Boolean((window as unknown as { __bpTraceHub?: unknown }).__bpTraceHub)
    )
  ).toBe(false);
  await page.goto(`${baseUrl}/basic.html?after-dispose=1`);
  expect(
    await page.evaluate(() =>
      Boolean((window as unknown as { __bpTraceHub?: unknown }).__bpTraceHub)
    )
  ).toBe(false);
}, 30000);

test('page-side recorder lease expires without affecting another trace owner', async () => {
  const { page, baseUrl } = ctx.get();
  await page.goto(`${baseUrl}/basic.html`);
  const trace = new LiveTraceCollector(page.cdpClient);
  await trace.start();
  const recorder = new Recorder(page.cdpClient, { maxIdleMs: 700 });
  await recorder.start();
  await Bun.sleep(400);
  await recorder.heartbeat();
  await Bun.sleep(400);
  expect(
    await page.evaluate(
      () =>
        Object.keys((window as unknown as { __bpRecorders?: object }).__bpRecorders ?? {}).length
    )
  ).toBe(1);
  await Bun.sleep(1000);
  expect(
    await page.evaluate(
      () =>
        Object.keys((window as unknown as { __bpRecorders?: object }).__bpRecorders ?? {}).length
    )
  ).toBe(0);
  await page.evaluate(() => console.error('surviving independent trace'));
  expect(trace.getEvents().some((e) => e.event === 'console.error')).toBe(true);
  await recorder.stop();
  await trace.stop();
}, 10000);
