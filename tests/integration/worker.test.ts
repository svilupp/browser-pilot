/**
 * Worker-hang proof.
 *
 * `Page.init()` installs a GLOBAL `Target.setAutoAttach({ flatten: true,
 * waitForDebuggerOnStart: true })` so cross-origin iframes (OOPIFs) attach as
 * child sessions we can drive. A side effect: EVERY child target — including
 * dedicated Workers and Service Workers — attaches PAUSED on start and relies on
 * the engine calling `Runtime.runIfWaitingForDebugger` (in
 * `handleTargetAttached`'s finally) to resume. If that release ever regressed,
 * workers would hang forever.
 *
 * There was no worker fixture in the suite, so this proves children still run:
 * the page spawns a dedicated Worker (and registers a Service Worker) that post
 * messages back; the assertions below only pass if those children executed
 * within a normal timeout — i.e. they were unpaused, not hung.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { withRetry } from '../utils/retry.ts';
import { TestContext } from './setup.ts';

const ctx = new TestContext();

describe('Worker targets do not hang under global auto-attach', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());

  test('dedicated Worker runs and posts back (not left paused on the debugger)', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      // If the worker were left paused, the page would still fire `load`, so the
      // real proof is the worker's message arriving — waitFor times out otherwise.
      await page.goto(`${baseUrl}/worker-page.html`);

      const appeared = await page.waitFor('#worker-result', { state: 'visible', timeout: 8000 });
      expect(appeared).toBe(true);

      const messages = await page.evaluate<string[]>('window.__workerMessages || []');
      // Readiness message posted on worker start.
      expect(messages).toContain('worker-ready:42');
      // Echo proves the worker also processed an inbound message.
      expect(messages).toContain('echo:ping');
    });
  }, 30000);

  test('Service Worker activates and becomes ready (child target unpaused)', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/worker-page.html`);

      // navigator.serviceWorker.ready only resolves once the SW reaches
      // "activated" — which cannot happen if the SW child target stays paused.
      const swReady = await page.waitFor('#sw-result', { state: 'visible', timeout: 10000 });
      const err = await page.evaluate<string | null>('window.__swError || null');
      expect(err).toBe(null);
      expect(swReady).toBe(true);

      const text = await page.text('#sw-result');
      expect(text).toContain('sw-ready');
    });
  }, 30000);
});
