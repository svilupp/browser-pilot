// Browser responses in this test are simulated; this tests workerd host behavior.
import { connect, createWorkersTransportFactory } from 'browser-pilot/adapters/workers';
import { ConnectionSessionOwner, connectCore } from 'browser-pilot/core';
import { runBp } from 'browser-pilot/shell';

let opens = 0;
const requests = [];
function upgrade() {
  opens++;
  const pair = new WebSocketPair();
  const server = pair[1];
  server.accept();
  server.addEventListener('message', (event) => {
    const request = JSON.parse(event.data);
    requests.push(request.method);
    let result = {};
    if (request.method === 'Browser.getVersion')
      result = { product: 'Chrome/fixture', revision: '@fixture' };
    if (request.method === 'Target.getTargets')
      result = {
        targetInfos: [
          { targetId: 'page', type: 'page', title: 'Fixture', url: 'https://fixture.test/' },
        ],
      };
    if (request.method === 'Target.attachToTarget') result = { sessionId: 'attached' };
    if (request.method === 'Runtime.evaluate')
      result = {
        result: {
          type: request.params.expression === 'document.title' ? 'string' : 'object',
          value: request.params.expression === 'document.title' ? 'Fixture' : { w: 1280, h: 720 },
        },
      };
    if (request.method === 'Page.captureScreenshot') result = { data: 'iVBORw0KGgo=' };
    server.send(new TextEncoder().encode(JSON.stringify({ id: request.id, result })).buffer);
  });
  return new Response(null, { status: 101, webSocket: pair[0] });
}
function assert(value, message) {
  if (!value) throw new Error(message);
}
export default {
  async fetch() {
    let acquisitions = 0;
    let releases = 0;
    const binding = {
      async acquire(options) {
        assert(
          options.keepAlive === 10000 && !('keep_alive' in options),
          'documented binding option'
        );
        acquisitions++;
        return { sessionId: 'allocation' };
      },
      async connectSession(id) {
        assert(id === 'allocation', 'exact allocation');
        return { webSocket: { fetch: async () => upgrade() } };
      },
      async closeSession(id) {
        assert(id === 'allocation', 'exact release');
        releases++;
        return { status: 'closed' };
      },
      async getSession() {
        return null;
      },
    };
    const browser = await connect({
      provider: 'cloudflare',
      cloudflare: { binding, keepAliveMs: 10000 },
    });
    assert((await (await browser.page()).title()) === 'Fixture', 'binding action');
    assert((await (await browser.page()).screenshot()) === 'iVBORw0KGgo=', 'binary artifact');
    assert((await browser.close()).status === 'released', 'binding release');
    assert(acquisitions === 1 && releases === 1, 'one lifecycle');
    const ctx = {
      generation: 'request',
      signal: new AbortController().signal,
      clock: { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    };
    const owner = new ConnectionSessionOwner({
      connect: (options) =>
        connectCore({
          ...options,
          transportFactory: createWorkersTransportFactory({ fetch: async () => upgrade() }),
        }),
    });
    const handle = await owner.open({ provider: 'generic', wsUrl: 'wss://fixture.test/cdp' }, ctx);
    const before = opens;
    const ports = {
      sessionOwner: owner,
      clock: ctx.clock,
      createContext: () => ctx,
      artifacts: {
        async put(bytes) {
          assert(bytes[0] === 137, 'PNG bytes');
          return {
            status: 'written',
            ref: 'fixture.png',
            path: 'fixture.png',
            size: bytes.length,
            hash: 'sha256:fixture',
            type: 'image/png',
          };
        },
      },
      capabilities: { read: true, action: true, evaluate: true, webmcp: true },
    };
    for (let i = 0; i < 2; i++) {
      const lease = await owner.acquire(handle, ctx);
      assert((await (await lease.browser.page()).title()) === 'Fixture', 'borrowed action');
      await lease.detach();
    }
    assert(opens === before, 'leases must not reconnect');
    const result = await runBp(
      ['tabs', JSON.stringify(handle)],
      { stdin: JSON.stringify(handle), readFile: async () => '' },
      ports,
      async () => {
        throw new Error('unexpected reconnect');
      }
    );
    assert(result.exitCode === 0, `shell command ${result.stderr}`);
    const screenshot = await runBp(
      ['screenshot', JSON.stringify(handle), '--out', 'fixture.png'],
      { stdin: '', readFile: async () => '' },
      ports,
      async () => {
        throw new Error('unexpected reconnect');
      }
    );
    assert(
      screenshot.exitCode === 0,
      `shell PNG receipt ${screenshot.stderr} requests=${JSON.stringify(requests)}`
    );
    /* companion runs */
    await owner.release(handle, ctx);
    const controller = new AbortController();
    controller.abort();
    let aborted = false;
    try {
      await createWorkersTransportFactory({ fetch: async () => upgrade() })('wss://fixture.test', {
        signal: controller.signal,
      });
    } catch {
      aborted = true;
    }
    assert(aborted, 'cancelled admission');
    let missing = false;
    try {
      await createWorkersTransportFactory({ fetch: async () => new Response('no socket') })(
        'wss://fixture.test'
      );
    } catch {
      missing = true;
    }
    assert(missing, 'missing upgrade');
    return Response.json({
      status: 'pass',
      browserResponses: 'simulated',
      acquisitions,
      releases,
      opens,
      compatibilityDate: '2026-07-30',
    });
  },
};
