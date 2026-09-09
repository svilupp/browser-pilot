/**
 * In-process end-to-end test for the `bp` just-bash bridge.
 *
 * Composes real, non-mocked pieces (no browser, no network):
 *  - `InProcessSessionOwner` (`src/adapters/node`) with the real `generic`
 *    provider — its `createSession()` is monkeypatched for the duration of
 *    this test to add a `sessionId` and a close-call counter, acting as the
 *    "scripted Provider" the task spec asks for (`GenericProvider.createSession`
 *    already returns `{ wsUrl, close() }` with no network I/O — see
 *    `src/providers/generic.ts`).
 *  - `MemoryArtifactSink` (`src/adapters/memory`, real, in-memory).
 *  - `FakeClock` (`src/adapters/memory`, real, manually advanced).
 *  - `registerBrowserPilotCommands` (`src/just-bash`, real) with an injected
 *    fake `connect` factory (no CDP connection is made).
 *  - a real `just-bash` `Bash` instance running real shell command lines.
 *
 * Artifact flow (documented, see assertions below): the `screenshot` command
 * calls `ports.artifacts.put(bytes, { path, type, ctx })` directly — it never
 * touches the just-bash Bash virtual filesystem (`ctx.fs`). So the artifact
 * lands in the `ArtifactSink`'s own store (here: `MemoryArtifactSink`'s
 * `store` map, keyed by a normalized path), not as a file readable through
 * `bash.exec('cat ...')` or any other VFS-facing command.
 */

import { describe, expect, test } from 'bun:test';
import { Bash } from 'just-bash';
import {
  createTestContext,
  FakeClock,
  MemoryArtifactSink,
  MemorySecrets,
} from '../../src/adapters/memory/index.ts';
import { InProcessSessionOwner } from '../../src/adapters/node/index.ts';
import { registerBrowserPilotCommands } from '../../src/just-bash/index.ts';
import type { BpBrowser, BrowserPilotJustBashPorts } from '../../src/just-bash/types.ts';
import { BrowserBaseProvider } from '../../src/providers/browserbase.ts';
import type { ProviderSession } from '../../src/providers/types.ts';

const GENERATION = 'e2e-gen-1';
const FAKE_WS_URL = 'ws://127.0.0.1:1/x';
const FAKE_SECRETS = new MemorySecrets({ BROWSERBASE_API_KEY: 'fake-key-for-test' });

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function pngBase64(): string {
  let binary = '';
  for (const b of PNG_BYTES) binary += String.fromCharCode(b);
  return btoa(binary);
}

function lastJson(text: string): Record<string, unknown> {
  const line = text.trim().split('\n').pop() ?? '';
  const value: unknown = JSON.parse(line);
  if (typeof value !== 'object' || value === null) {
    throw new Error(`expected JSON object, got: ${line}`);
  }
  return value as Record<string, unknown>;
}

/**
 * Monkeypatch `BrowserBaseProvider.prototype.createSession` for the duration
 * of `fn()` to return a fully scripted `ProviderSession` — no network I/O,
 * no real BrowserBase account. This is the "scripted Provider" the task spec
 * asks for: `createSession()` returns `{ wsUrl, sessionId, close() }`, and
 * `close()` is counted so the test can assert it runs exactly once.
 * `InProcessSessionOwner` (real, from `src/adapters/node`) still owns the
 * session lifecycle and generation fencing around this scripted provider.
 */
async function withScriptedProvider<T>(fn: (closeCalls: () => number) => Promise<T>): Promise<T> {
  const original = BrowserBaseProvider.prototype.createSession;
  let closeCount = 0;
  BrowserBaseProvider.prototype.createSession = async (_options): Promise<ProviderSession> => ({
    wsUrl: FAKE_WS_URL,
    sessionId: 'scripted-session-1',
    close: async () => {
      closeCount++;
      return { status: 'released', sessionId: 'scripted-session-1' };
    },
  });
  try {
    return await fn(() => closeCount);
  } finally {
    BrowserBaseProvider.prototype.createSession = original;
  }
}

function makeConnect(): { connect: BrowserPilotJustBashPorts['connect']; disconnects: number[] } {
  const disconnects = [0];
  const browser: BpBrowser = {
    async page() {
      return {
        async goto() {},
        async url() {
          return 'https://example.com/';
        },
        async title() {
          return 'Example';
        },
        async text() {
          return 'hello';
        },
        async snapshot() {
          return {};
        },
        async screenshot() {
          return pngBase64();
        },
        async evaluate() {
          return null;
        },
        async click() {
          return true;
        },
        async type() {
          return true;
        },
        async press() {},
        async webmcpList() {
          return { status: { available: false }, tools: [] };
        },
        async webmcpCall() {
          return null;
        },
      };
    },
    async listTargets() {
      return [];
    },
    async disconnect() {
      disconnects[0]!++;
    },
  };
  return {
    connect: async (wsUrl: string) => {
      expect(wsUrl).toBe(FAKE_WS_URL);
      return browser;
    },
    disconnects: disconnects,
  };
}

describe('just-bash + adapters e2e (in-process, no browser)', () => {
  test('Browserbase preserves navigation across command disconnects and releases only on close', async () => {
    const originalFetch = globalThis.fetch;
    let keepAlive = false;
    let alive = false;
    let currentUrl = 'about:blank';
    let creates = 0;
    let releases = 0;
    let disconnects = 0;
    const session = { id: 'persistent-session', projectId: 'project', connectUrl: FAKE_WS_URL };
    try {
      // Model the provider contract: disconnect ends sessions unless creation requested keepAlive.
      // @ts-expect-error minimal mock
      globalThis.fetch = async (url: string, init?: RequestInit) => {
        if (url.endsWith('/v1/sessions')) {
          creates++;
          const body = JSON.parse(String(init?.body));
          keepAlive = body.keepAlive === true;
          expect(body.browserSettings.viewport).toEqual({ width: 1280, height: 720 });
          alive = true;
          return Response.json({ ...session, status: 'RUNNING' });
        }
        expect(url).toEndWith('/v1/sessions/persistent-session');
        if (init?.method === 'POST') {
          expect(JSON.parse(String(init.body))).toEqual({
            projectId: 'project',
            status: 'REQUEST_RELEASE',
          });
          releases++;
          alive = false;
        }
        return Response.json({ ...session, status: alive ? 'RUNNING' : 'COMPLETED' });
      };
      const owner = new InProcessSessionOwner({
        secrets: new MemorySecrets({
          BROWSERBASE_API_KEY: 'synthetic-key',
          BROWSERBASE_PROJECT_ID: 'project',
        }),
      });
      const bash = new Bash({
        defenseInDepth: false,
        customCommands: registerBrowserPilotCommands({
          sessionOwner: owner,
          clock: new FakeClock(),
          createContext: () => createTestContext({ generation: GENERATION }),
          capabilities: { read: true, evaluate: false, action: false, webmcp: false },
          connect: async (wsUrl, ctx) => {
            expect(wsUrl).toBe(FAKE_WS_URL);
            if (!alive) throw new Error('Provider session ended on disconnect');
            const base = await makeConnect().connect!(wsUrl, ctx);
            return {
              ...base,
              page: async (options) => {
                expect(options?.targetId).toBe('stable-target');
                return {
                  ...(await base.page()),
                  targetId: 'stable-target',
                  goto: async (url) => {
                    currentUrl = url;
                  },
                  url: async () => currentUrl,
                  text: async () => `Document at ${currentUrl}`,
                };
              },
              disconnect: async () => {
                disconnects++;
                if (!keepAlive) alive = false;
              },
            };
          },
        }),
      });
      expect(
        (
          await bash.exec(
            'bp session open --provider browserbase --width 1280 --height 720 > /session.json'
          )
        ).exitCode
      ).toBe(0);
      const goto = await bash.exec(
        'bp goto --handle-file /session.json --target stable-target https://example.com/persisted'
      );
      expect(goto.exitCode).toBe(0);
      const read = await bash.exec('bp text --handle-file /session.json --target stable-target');
      expect(read.exitCode).toBe(0);
      expect(lastJson(read.stdout)['text']).toBe('Document at https://example.com/persisted');
      expect(creates).toBe(1);
      expect(disconnects).toBe(2);
      expect(releases).toBe(0);
      expect(alive).toBe(true);
      const closed = await bash.exec('bp session close --handle-file /session.json');
      expect(closed.exitCode).toBe(0);
      expect(lastJson(closed.stdout)['status']).toBe('released');
      expect(releases).toBe(1);
      expect(alive).toBe(false);
      expect(owner.size).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('session open -> screenshot -> session close, real pieces end to end', async () => {
    await withScriptedProvider(async (closeCalls) => {
      const clock = new FakeClock(1_000_000);
      const owner = new InProcessSessionOwner({ clock, secrets: FAKE_SECRETS });
      const artifacts = MemoryArtifactSink();
      const { connect, disconnects } = makeConnect();

      const controller = new AbortController();
      const ports: BrowserPilotJustBashPorts = {
        sessionOwner: owner,
        artifacts,
        clock,
        createContext: () =>
          createTestContext({ signal: controller.signal, generation: GENERATION, clock }),
        capabilities: { read: true, evaluate: true, action: true, webmcp: true },
        connect,
      };

      const bash = new Bash({
        customCommands: registerBrowserPilotCommands(ports),
        files: {},
        defenseInDepth: false,
      });

      // 1. session open
      const openRes = await bash.exec(
        'bp session open --provider browserbase --width 1 --height 1'
      );
      expect(openRes.exitCode).toBe(0);
      const handle = lastJson(openRes.stdout);
      expect(handle['generation']).toBe(GENERATION);
      expect(handle['provider']).toBe('browserbase');
      expect(owner.size).toBe(1);

      const handleArg = `'${JSON.stringify(handle)}'`;

      // 2. screenshot -> real MemoryArtifactSink
      const shotRes = await bash.exec(`bp screenshot ${handleArg} --out workspace/a.png`);
      expect(shotRes.exitCode).toBe(0);
      const receipt = lastJson(shotRes.stdout);
      expect(receipt['status']).toBe('written');
      expect(typeof receipt['hash']).toBe('string');
      expect(String(receipt['hash'])).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(receipt['size']).toBe(PNG_BYTES.byteLength);

      // Artifact flow: the sink writes to its own store, keyed by the
      // normalized `--out` path — NOT into the Bash instance's virtual
      // filesystem. `cat` on the same path through the shell finds nothing.
      expect(artifacts.store.has('workspace/a.png')).toBe(true);
      expect(artifacts.store.get('workspace/a.png')?.hash).toBe(
        String(receipt['hash']).replace('sha256:', '')
      );
      const catRes = await bash.exec('cat workspace/a.png');
      expect(catRes.exitCode).not.toBe(0);

      // 3. session close -> release result + provider close called once
      const closeRes = await bash.exec(`bp session close ${handleArg}`);
      expect(closeRes.exitCode).toBe(0);
      const released = lastJson(closeRes.stdout);
      expect(released['status']).toBe('released');
      expect(released['sessionId']).toBe('scripted-session-1');
      expect(owner.size).toBe(0);
      expect(closeCalls()).toBe(1);

      // browser.disconnect() (not close/release) is called per bp invocation
      // that opened a CDP connection — screenshot only.
      expect(disconnects[0]).toBe(1);
    });
  });

  test('wrong-generation handle fails with usage exit 2', async () => {
    const clock = new FakeClock(1_000_000);
    const owner = new InProcessSessionOwner({ clock });
    const controller = new AbortController();
    const ports: BrowserPilotJustBashPorts = {
      sessionOwner: owner,
      clock,
      createContext: () =>
        createTestContext({ signal: controller.signal, generation: GENERATION, clock }),
      capabilities: { read: true, evaluate: true, action: true, webmcp: true },
      connect: makeConnect().connect,
    };
    const bash = new Bash({
      customCommands: registerBrowserPilotCommands(ports),
      files: {},
      defenseInDepth: false,
    });

    const staleHandle = {
      id: 'h-x',
      generation: 'some-other-generation',
      provider: 'generic',
    };
    const res = await bash.exec(`bp goto '${JSON.stringify(staleHandle)}' https://example.com/`);
    expect(res.exitCode).toBe(2);
    const err = lastJson(res.stderr);
    expect(err['error']).toBe('stale_generation');
  });

  test('capability denied fails with exit 3', async () => {
    const clock = new FakeClock(1_000_000);
    const owner = new InProcessSessionOwner({ clock });
    const controller = new AbortController();
    const ports: BrowserPilotJustBashPorts = {
      sessionOwner: owner,
      clock,
      createContext: () =>
        createTestContext({ signal: controller.signal, generation: GENERATION, clock }),
      capabilities: { read: false, evaluate: false, action: false, webmcp: false },
      connect: makeConnect().connect,
    };
    const bash = new Bash({
      customCommands: registerBrowserPilotCommands(ports),
      files: {},
      defenseInDepth: false,
    });

    const res = await bash.exec('bp session open --provider generic');
    expect(res.exitCode).toBe(3);
    const err = lastJson(res.stderr);
    expect(err['error']).toBe('capability_denied');
    expect(err['capability']).toBe('read');
  });
});
