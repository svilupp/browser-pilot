/**
 * Emit integration tests - real Chrome, real WebSockets.
 *
 * The fixture opens sockets in three realms (main frame with a bound `send`,
 * same-origin iframe, dedicated worker) plus one closed socket, so these tests
 * exercise the parts a mocked CDP cannot prove: that the heap sweep reaches
 * every realm and that frames genuinely leave the browser.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EmitTargetError } from '../../src/index.ts';
import { TestContext } from './setup.ts';

const ctx = new TestContext();

/** Poll the fixture's log until an entry matches, so tests never sleep blindly. */
async function waitForLogEntry(
  page: { evaluate: (expression: string) => Promise<unknown> },
  predicate: string,
  timeout = 5000
): Promise<string[]> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const raw = (await page.evaluate(
      `JSON.stringify((window.__received || []).filter((entry) => ${predicate}))`
    )) as string;
    const matches = JSON.parse(raw ?? '[]') as string[];
    if (matches.length > 0) return matches;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return [];
}

describe('emit (integration)', () => {
  beforeAll(async () => {
    await ctx.setup();
    const { page, baseUrl } = ctx.get();
    await page.goto(`${baseUrl}/websocket.html`);
    // All three sockets must be open before any sweep is meaningful.
    for (const name of ['main', 'frame', 'worker']) {
      const entries = await waitForLogEntry(page, `entry.indexOf("${name}:open") !== -1`, 15000);
      if (entries.length === 0) throw new Error(`Timed out waiting for ${name} socket to open`);
    }
  }, 60000);
  afterAll(() => ctx.teardown());

  test('lists sockets across main frame, iframe, and worker', async () => {
    const { page } = ctx.get();

    const candidates = await page.listMessageTargets();
    const byName = (name: string) => candidates.find((c) => c.url.includes(`name=${name}`));

    expect(byName('main')).toBeDefined();
    expect(byName('frame')).toBeDefined();
    expect(byName('worker')).toBeDefined();
    expect(byName('main')?.realm).toBe('main');
    expect(byName('frame')?.realm).toBe('frame');
    expect(byName('worker')?.realm).toBe('worker');
  }, 20000);

  test('lists each socket exactly once', async () => {
    const { page } = ctx.get();

    const candidates = await page.listMessageTargets();
    const urls = candidates.map((c) => c.url);

    expect(new Set(urls).size).toBe(urls.length);
  }, 20000);

  test('sends on a socket whose send() was bound at construction', async () => {
    const { page } = ctx.get();

    const result = await page.emitMessage('{"type":"hello-main"}', { match: 'name=main' });

    expect(result.delivered).toBe(true);
    expect(result.socketUrl).toContain('name=main');

    const echoes = await waitForLogEntry(page, 'entry.indexOf("hello-main") !== -1');
    expect(echoes.length).toBeGreaterThan(0);
    expect(echoes[0]).toContain('"from":"main"');
  }, 20000);

  test('sends on the iframe socket', async () => {
    const { page } = ctx.get();

    const result = await page.emitMessage('{"type":"hello-frame"}', { match: 'name=frame' });

    expect(result.delivered).toBe(true);
    expect(result.realm).toBe('frame');

    const echoes = await waitForLogEntry(page, 'entry.indexOf("hello-frame") !== -1');
    expect(echoes[0]).toContain('"from":"frame"');
  }, 20000);

  test('sends on the worker socket', async () => {
    const { page } = ctx.get();

    const result = await page.emitMessage('{"type":"hello-worker"}', { match: 'name=worker' });

    expect(result.delivered).toBe(true);
    expect(result.realm).toBe('worker');

    const echoes = await waitForLogEntry(page, 'entry.indexOf("hello-worker") !== -1');
    expect(echoes[0]).toContain('"from":"worker"');
  }, 20000);

  test('refuses to guess when several sockets are open', async () => {
    const { page } = ctx.get();

    await expect(page.emitMessage('{"type":"ambiguous"}')).rejects.toThrow(EmitTargetError);
  }, 20000);

  test('never selects the closed socket', async () => {
    const { page } = ctx.get();

    // A send on a closed socket is silently discarded by the browser, so
    // selecting one would report success while losing the message.
    await expect(page.emitMessage('{"type":"dead"}', { match: 'name=closed' })).rejects.toThrow(
      /No open WebSocket/
    );
  }, 20000);

  test('awaitReply correlates the echo with the frame that caused it', async () => {
    const { page } = ctx.get();

    const result = await page.emitMessage('{"type":"needs-reply"}', {
      match: 'name=main',
      awaitReply: { where: { from: 'main' }, timeout: 5000 },
    });

    expect(result.reply).toBeDefined();
    expect(result.reply?.payload).toContain('needs-reply');
    expect(result.reply?.latencyMs).toBeLessThan(5000);
  }, 20000);

  test('awaitReply gives up rather than matching an unrelated frame', async () => {
    const { page } = ctx.get();

    const result = await page.emitMessage('{"type":"no-such-reply"}', {
      match: 'name=main',
      awaitReply: { where: { from: 'nobody' }, timeout: 1000 },
    });

    expect(result.delivered).toBe(true);
    expect(result.reply).toBeUndefined();
  }, 20000);

  test('sends binary frames', async () => {
    const { page } = ctx.get();

    const payload = Buffer.from('binary-payload').toString('base64');
    const result = await page.emitMessage(payload, { match: 'name=main', base64: true });

    expect(result.delivered).toBe(true);

    const echoes = await waitForLogEntry(page, 'entry.indexOf("binaryBytes") !== -1');
    expect(echoes[0]).toContain('"binaryBytes":14');
  }, 20000);

  test('emit works as a batch step and reports the socket it used', async () => {
    const { page } = ctx.get();

    const result = await page.batch([
      {
        action: 'emit',
        payload: { type: 'from-batch' },
        match: 'name=main',
        awaitReply: { where: { from: 'main' }, timeout: 5000 },
      },
    ]);

    expect(result.success).toBe(true);
    const value = result.steps[0]?.result as { delivered: boolean; socketUrl: string };
    expect(value.delivered).toBe(true);
    expect(value.socketUrl).toContain('name=main');
  }, 20000);
});
