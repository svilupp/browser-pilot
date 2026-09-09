/**
 * Unit tests for the just-bash `bp` command bridge.
 *
 * Runs real just-bash command lines (pipes, stdin, VFS files) against fakes:
 * a scripted SessionOwner, an in-memory ArtifactSink, a FakeClock, and an
 * injected connect() factory so no real CDP connection is made.
 */

import { describe, expect, test } from 'bun:test';
import { Bash } from 'just-bash';
import { InProcessSessionOwner } from '../../src/adapters/node/index.ts';
import type {
  ArtifactPutResult,
  ArtifactSink,
  ExecutionContext,
  SessionHandle,
  SessionOwner,
} from '../../src/just-bash/index.ts';
import { CapabilityError, registerBrowserPilotCommands } from '../../src/just-bash/index.ts';
import type { BpBrowser, BpPage, BrowserPilotShellPorts } from '../../src/shell/types.ts';

// ---------- fakes ----------

class FakeClock {
  t = 1_000_000;
  now(): number {
    return this.t;
  }
  async sleep(_ms: number, _signal?: AbortSignal): Promise<void> {}
}

const GENERATION = 'gen-1';
const SECRET_WS = 'ws://secret-host:9222/devtools/browser/abc?apiKey=topsecret';

function makeHandle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    id: 'h-1',
    generation: GENERATION,
    provider: 'browserbase',
    sessionId: 'sess-1',
    ...overrides,
  };
}

function scriptedOwner(overrides: Partial<SessionOwner> = {}): SessionOwner {
  return {
    async open(opts, _ctx) {
      return makeHandle({ provider: opts.provider });
    },
    async resolve(_handle, _ctx) {
      return { wsUrl: SECRET_WS };
    },
    async release(handle, _ctx) {
      return { status: 'released', sessionId: handle.sessionId ?? handle.id };
    },
    async touch(handle, _ctx) {
      return { ...handle, leaseExpiresAt: 2_000_000 };
    },
    ...overrides,
  };
}

class MemorySink implements ArtifactSink {
  writes: Array<{ path: string; type: string; bytes: Uint8Array }> = [];
  result?: ArtifactPutResult;
  async put(
    bytes: Uint8Array,
    opts: { path: string; type: string; ctx: ExecutionContext }
  ): Promise<ArtifactPutResult> {
    this.writes.push({ path: opts.path, type: opts.type, bytes });
    return (
      this.result ?? {
        status: 'written',
        ref: `mem:${opts.path}`,
        path: opts.path,
        size: bytes.byteLength,
        hash: 'sha256:feedface',
        type: opts.type,
      }
    );
  }
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

interface FakePageState {
  url: string;
  title: string;
  text: string;
  onClick?: () => Promise<boolean> | boolean;
  onType?: () => Promise<boolean> | boolean;
  onPress?: () => Promise<void> | void;
}

function fakePage(state: FakePageState): BpPage {
  return {
    async goto(url) {
      state.url = url;
    },
    async url() {
      return state.url;
    },
    async title() {
      return state.title;
    },
    async text(selector) {
      return selector ? `[${selector}] ${state.text}` : state.text;
    },
    async snapshot() {
      return { url: state.url, title: state.title, interactiveElements: [{ ref: 'e1' }] };
    },
    async screenshot() {
      let binary = '';
      for (const b of PNG_BYTES) binary += String.fromCharCode(b);
      return btoa(binary);
    },
    async evaluate(expression) {
      return `evaluated:${expression}`;
    },
    async click() {
      return (await state.onClick?.()) ?? true;
    },
    async type() {
      return (await state.onType?.()) ?? true;
    },
    async press() {
      await state.onPress?.();
    },
    async webmcpList(fromOrigins) {
      return {
        status: { available: true, url: state.url },
        tools: [{ name: 'get_cart', origin: 'https://shop.example', fromOrigins }],
      };
    },
    async webmcpCall(name, input, options) {
      if (name !== 'get_cart') throw new Error(`tool ${name} not found`);
      return { called: name, input: input ?? null, allowMutation: options?.allowMutation ?? false };
    },
  };
}

interface Harness {
  bash: Bash;
  clock: FakeClock;
  sink: MemorySink;
  page: FakePageState;
  connects: string[];
  disconnects: number;
  pageTargets: Array<string | undefined>;
  controller: AbortController;
  handleArg: string;
}

function makeHarness(
  options: {
    capabilities?: Partial<BrowserPilotShellPorts['capabilities']>;
    owner?: Partial<SessionOwner>;
    artifacts?: ArtifactSink | null;
    limits?: BrowserPilotShellPorts['limits'];
    deadline?: number;
    preAborted?: boolean;
    files?: Record<string, string>;
    pageOverrides?: Partial<BpPage>;
  } = {}
): Harness {
  const clock = new FakeClock();
  const sink = new MemorySink();
  const page: FakePageState = {
    url: 'https://example.com/',
    title: 'Example',
    text: 'Hello 🌍 world',
  };
  const controller = new AbortController();
  if (options.preAborted) controller.abort();
  const connects: string[] = [];
  const harness: Harness = {
    bash: undefined as unknown as Bash,
    clock,
    sink,
    page,
    connects,
    disconnects: 0,
    pageTargets: [],
    controller,
    handleArg: `'${JSON.stringify(makeHandle())}'`,
  };
  const browser: BpBrowser = {
    async page(pageOptions) {
      harness.pageTargets.push(pageOptions?.targetId);
      return { ...fakePage(page), ...options.pageOverrides };
    },
    async listTargets() {
      return [
        { targetId: 't1', type: 'page', url: page.url, title: page.title },
        { targetId: 't2', type: 'page', url: 'https://other.example/', title: 'Other' },
      ];
    },
    async disconnect() {
      harness.disconnects++;
    },
  };
  const ports: BrowserPilotShellPorts = {
    sessionOwner: scriptedOwner(options.owner),
    artifacts: options.artifacts === null ? undefined : (options.artifacts ?? sink),
    clock,
    createContext: () => ({
      signal: controller.signal,
      generation: GENERATION,
      clock,
      ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
    }),
    capabilities: {
      read: true,
      evaluate: true,
      action: true,
      webmcp: true,
      ...options.capabilities,
    },
    limits: options.limits,
    connect: async (wsUrl, _ctx) => {
      connects.push(wsUrl);
      return browser;
    },
  };
  harness.bash = new Bash({
    customCommands: registerBrowserPilotCommands(ports),
    files: options.files ?? {},
    // Bun cannot apply just-bash's Node-specific Module._resolveFilename
    // patches; the defense-in-depth layer is irrelevant for these unit tests.
    defenseInDepth: false,
  });
  return harness;
}

function lastJson(text: string): Record<string, unknown> {
  const line = text.trim().split('\n').pop() ?? '';
  const value: unknown = JSON.parse(line);
  if (typeof value !== 'object' || value === null) throw new Error(`expected JSON object: ${line}`);
  return value as Record<string, unknown>;
}

// ---------- tests ----------

describe('bp session', () => {
  test('built-in owner rejects Browserless before connecting, while custom owners can support it', async () => {
    const owner = new InProcessSessionOwner();
    const builtIn = makeHarness({ owner: { open: (opts, ctx) => owner.open(opts, ctx) } });
    const rejected = await builtIn.bash.exec(
      'bp session open --provider browserless && echo SHOULD_NOT_RUN'
    );
    expect(rejected.exitCode).toBe(3);
    expect(lastJson(rejected.stderr)['capability']).toBe('session-reconnect');
    expect(rejected.stdout).toBe('');
    expect(builtIn.connects).toEqual([]);
    expect(owner.size).toBe(0);

    const custom = makeHarness();
    expect((await custom.bash.exec('bp session open --provider browserless')).exitCode).toBe(0);
  });

  test('browser-use errors are sanitized at the provider boundary before reaching shell stderr', async () => {
    const originalFetch = globalThis.fetch;
    const secret = 'synthetic-private-browser-use-key';
    try {
      // @ts-expect-error minimal mock
      globalThis.fetch = async () =>
        Response.json({ token: secret, authorization: secret }, { status: 403 });
      const owner = new InProcessSessionOwner({ secrets: { get: () => secret } });
      const h = makeHarness({ owner: { open: (opts, ctx) => owner.open(opts, ctx) } });
      const res = await h.bash.exec('bp session open --provider browser-use');
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain('HTTP 403');
      expect(res.stderr).not.toContain(secret);
      expect(owner.size).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  for (const failure of ['http', 'network', 'active', 'invalid-json', 'wrong-session'] as const) {
    test(`browser-use ${failure} stop failure retains the session until a successful retry`, async () => {
      const originalFetch = globalThis.fetch;
      const secret = 'synthetic-private-browser-use-key';
      let stopCalls = 0;
      const session = { id: 'browser-use-session', status: 'active', cdpUrl: SECRET_WS };
      try {
        // @ts-expect-error minimal mock
        globalThis.fetch = async (_url: string, init?: RequestInit) => {
          if (init?.method === 'POST') return Response.json(session);
          stopCalls++;
          if (stopCalls === 1) {
            if (failure === 'http') return Response.json({ token: secret }, { status: 500 });
            if (failure === 'network') throw new Error(`network error ${secret}`);
            if (failure === 'invalid-json') return new Response(`broken JSON ${secret}`);
            if (failure === 'wrong-session')
              return Response.json({ ...session, id: 'another-session', status: 'stopped' });
            return Response.json(session);
          }
          return Response.json({ ...session, status: 'stopped' });
        };
        const owner = new InProcessSessionOwner({ secrets: { get: () => secret } });
        const h = makeHarness({
          owner: {
            open: (opts, ctx) => owner.open(opts, ctx),
            release: (handle, ctx) => owner.release(handle, ctx),
          },
        });
        expect(
          (await h.bash.exec('bp session open --provider browser-use > /session.json')).exitCode
        ).toBe(0);
        const first = await h.bash.exec(
          'bp session close --handle-file /session.json && echo SHOULD_NOT_RUN'
        );
        expect(first.exitCode).toBe(1);
        expect(JSON.parse(first.stdout)['status']).toBe('cleanup_pending');
        expect(first.stdout).not.toContain(secret);
        expect(first.stdout).not.toContain('SHOULD_NOT_RUN');
        expect(owner.size).toBe(1);
        const retry = await h.bash.exec('bp session close --handle-file /session.json');
        expect(retry.exitCode).toBe(0);
        expect(JSON.parse(retry.stdout)['status']).toBe('released');
        expect(owner.size).toBe(0);
        expect(stopCalls).toBe(2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  test('generic sessions use the trusted host endpoint through the real owner', async () => {
    const owner = new InProcessSessionOwner({ genericWsUrl: SECRET_WS });
    const h = makeHarness({
      owner: {
        open: (opts, ctx) => owner.open(opts, ctx),
        resolve: (handle, ctx) => owner.resolve(handle, ctx),
        release: (handle, ctx) => owner.release(handle, ctx),
      },
    });
    const opened = await h.bash.exec('bp session open --provider generic > /generic.json');
    expect(opened.exitCode).toBe(0);
    const serialized = await h.bash.exec('cat /generic.json');
    expect(lastJson(serialized.stdout)['provider']).toBe('generic');
    expect(serialized.stdout).not.toContain(SECRET_WS);
    const read = await h.bash.exec('bp text --handle-file /generic.json');
    expect(read.exitCode).toBe(0);
    expect(h.connects).toEqual([SECRET_WS]);
    expect((await h.bash.exec('bp session close --handle-file /generic.json')).exitCode).toBe(0);
    expect(owner.size).toBe(0);
    const stale = await h.bash.exec('bp text --handle-file /generic.json');
    expect(stale.exitCode).toBe(2);
    expect(lastJson(stale.stderr)['error']).toBe('stale_handle');
    expect(h.connects).toHaveLength(1);
  });

  test('unconfigured generic endpoint gives an actionable host capability error', async () => {
    const owner = new InProcessSessionOwner();
    const h = makeHarness({ owner: { open: (opts, ctx) => owner.open(opts, ctx) } });
    const res = await h.bash.exec('bp session open --provider generic');
    expect(res.exitCode).toBe(3);
    expect(lastJson(res.stderr)['capability']).toBe('generic-endpoint');
    expect(lastJson(res.stderr)['message']).toContain('genericWsUrl');
  });

  test('open prints a credential-free handle', async () => {
    const h = makeHarness();
    const res = await h.bash.exec(
      'bp session open --provider browserbase --width 1280 --height 720'
    );
    expect(res.exitCode).toBe(0);
    const handle = lastJson(res.stdout);
    expect(handle['id']).toBe('h-1');
    expect(handle['generation']).toBe(GENERATION);
    expect(handle['provider']).toBe('browserbase');
    expect(Object.keys(handle).sort()).toEqual(['generation', 'id', 'provider', 'sessionId']);
    expect(res.stdout).not.toContain('ws://');
    expect(res.stdout).not.toContain('topsecret');
    expect(res.stdout).not.toContain('apiKey');
  });

  test('open rejects unknown provider with usage exit 2', async () => {
    const h = makeHarness();
    const res = await h.bash.exec('bp session open --provider chrome');
    expect(res.exitCode).toBe(2);
    expect(lastJson(res.stderr)['error']).toBe('usage');
  });

  test('close prints the ProviderReleaseResult', async () => {
    const h = makeHarness();
    const res = await h.bash.exec(`bp session close ${h.handleArg}`);
    expect(res.exitCode).toBe(0);
    const released = lastJson(res.stdout);
    expect(released['status']).toBe('released');
    expect(released['sessionId']).toBe('sess-1');
  });

  test('close whitelist-sanitizes a host-supplied error field that embeds a wsUrl/apiKey', async () => {
    const h = makeHarness({
      owner: {
        async release(handle, _ctx) {
          return {
            status: 'cleanup_pending',
            sessionId: handle.sessionId ?? handle.id,
            providerStatus: 'unknown',
            error: `provider unreachable at ${SECRET_WS}?apiKey=SECRET`,
          };
        },
      },
    });
    const res = await h.bash.exec(`bp session close ${h.handleArg}`);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).not.toContain('SECRET');
    expect(res.stdout).not.toContain('secret-host');
    expect(res.stdout).not.toContain('ws://');
    const released = lastJson(res.stdout);
    expect(released['status']).toBe('cleanup_pending');
    expect(Object.keys(released).sort()).toEqual([
      'error',
      'providerStatus',
      'sessionId',
      'status',
    ]);
  });

  test('touch prints the refreshed handle', async () => {
    const h = makeHarness();
    const res = await h.bash.exec(`bp session touch ${h.handleArg}`);
    expect(res.exitCode).toBe(0);
    expect(lastJson(res.stdout)['leaseExpiresAt']).toBe(2_000_000);
  });

  test('touch without host support fails with exit 1', async () => {
    const h = makeHarness({ owner: { touch: undefined } });
    const res = await h.bash.exec(`bp session touch ${h.handleArg}`);
    expect(res.exitCode).toBe(1);
    expect(lastJson(res.stderr)['error']).toBe('unsupported');
  });
});

describe('bp read commands', () => {
  test('goto navigates and reports final url/title', async () => {
    const h = makeHarness();
    const res = await h.bash.exec(`bp goto ${h.handleArg} https://target.example/page`);
    expect(res.exitCode).toBe(0);
    const out = lastJson(res.stdout);
    expect(out['ok']).toBe(true);
    expect(out['url']).toBe('https://target.example/page');
    expect(out['title']).toBe('Example');
    expect(h.connects).toEqual([SECRET_WS]);
    expect(h.disconnects).toBe(1);
  });

  test('tabs lists targets and works in a pipe', async () => {
    const h = makeHarness();
    const res = await h.bash.exec(`bp tabs ${h.handleArg} --format text | head -1`);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('t1\tpage\thttps://example.com/\tExample');
  });

  test('inspect prints the page snapshot', async () => {
    const h = makeHarness();
    const res = await h.bash.exec(`bp inspect ${h.handleArg}`);
    expect(res.exitCode).toBe(0);
    const snap = lastJson(res.stdout);
    expect(snap['url']).toBe('https://example.com/');
    expect(snap['interactiveElements']).toEqual([{ ref: 'e1' }]);
  });

  test('text returns unicode text as JSON and raw with --format text', async () => {
    const h = makeHarness();
    const asJson = await h.bash.exec(`bp text ${h.handleArg}`);
    expect(lastJson(asJson.stdout)['text']).toBe('Hello 🌍 world');
    const asText = await h.bash.exec(`bp text ${h.handleArg} '#main' --format text`);
    expect(asText.stdout).toBe('[#main] Hello 🌍 world\n');
  });

  test('unicode output survives shell pipes', async () => {
    const h = makeHarness();
    const res = await h.bash.exec(`bp text ${h.handleArg} --format text | cat`);
    expect(res.stdout).toContain('🌍');
  });

  test('handle can come from a VFS file', async () => {
    const h = makeHarness({ files: { '/handle.json': `${JSON.stringify(makeHandle())}\n` } });
    const res = await h.bash.exec('bp text --handle-file /handle.json');
    expect(res.exitCode).toBe(0);
    expect(lastJson(res.stdout)['text']).toBe('Hello 🌍 world');
  });

  test('handle can come from stdin via --handle-file -', async () => {
    const h = makeHarness({ files: { '/handle.json': `${JSON.stringify(makeHandle())}\n` } });
    const res = await h.bash.exec('cat /handle.json | bp text --handle-file -');
    expect(res.exitCode).toBe(0);
    expect(lastJson(res.stdout)['text']).toBe('Hello 🌍 world');
  });

  test('malformed handle is a usage error', async () => {
    const h = makeHarness();
    const res = await h.bash.exec(`bp text '{"id":"x"}'`);
    expect(res.exitCode).toBe(2);
    expect(lastJson(res.stderr)['error']).toBe('usage');
  });

  test('explicit target is passed through on each page command', async () => {
    const h = makeHarness();
    const first = await h.bash.exec(`bp text ${h.handleArg} --target t2`);
    const second = await h.bash.exec(`bp inspect ${h.handleArg} --target t2`);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(h.pageTargets).toEqual(['t2', 't2']);
  });
});

describe('bp screenshot', () => {
  for (const cancelled of [false, true]) {
    test(`pending screenshot preserves its receipt and stops success chains (${cancelled ? 'cancelled' : 'deadline'})`, async () => {
      const h = makeHarness();
      const put = h.sink.put.bind(h.sink);
      h.sink.put = async (...args) => {
        if (cancelled) h.controller.abort();
        return put(...args);
      };
      h.sink.result = {
        status: 'write_pending_after_deadline',
        path: 'shot.png',
        ref: 'memory://shot.png',
        error: 'write still pending',
      };
      const res = await h.bash.exec(
        `bp screenshot ${h.handleArg} --out shot.png && echo SHOULD_NOT_RUN`
      );
      expect(res.exitCode).toBe(cancelled ? 130 : 124);
      expect(JSON.parse(res.stdout)['status']).toBe('write_pending_after_deadline');
      expect(res.stdout).not.toContain('SHOULD_NOT_RUN');
      expect(h.sink.writes).toHaveLength(1);
    });
  }

  test('writes bytes to the artifact sink and prints a receipt', async () => {
    const h = makeHarness();
    const res = await h.bash.exec(`bp screenshot ${h.handleArg} --out /workspace/shot.png`);
    expect(res.exitCode).toBe(0);
    const receipt = lastJson(res.stdout);
    expect(receipt['status']).toBe('written');
    expect(receipt['ref']).toBe('mem:/workspace/shot.png');
    expect(receipt['hash']).toBe('sha256:feedface');
    expect(receipt['size']).toBe(PNG_BYTES.byteLength);
    expect(receipt['type']).toBe('image/png');
    expect(h.sink.writes).toHaveLength(1);
    expect(Array.from(h.sink.writes[0]?.bytes ?? [])).toEqual(Array.from(PNG_BYTES));
  });

  test('without an artifact sink fails with capability exit 3', async () => {
    const h = makeHarness({ artifacts: null });
    const res = await h.bash.exec(`bp screenshot ${h.handleArg} --out /shot.png`);
    expect(res.exitCode).toBe(3);
    const err = lastJson(res.stderr);
    expect(err['error']).toBe('capability_denied');
    expect(err['capability']).toBe('artifacts');
  });

  test('failed artifact write surfaces status and exit 1', async () => {
    const h = makeHarness();
    h.sink.result = {
      status: 'failed',
      path: '/shot.png',
      error: `disk full at ${SECRET_WS}`,
      dispatched: true,
    };
    const res = await h.bash.exec(`bp screenshot ${h.handleArg} --out /shot.png`);
    expect(res.exitCode).toBe(1);
    const receipt = lastJson(res.stdout);
    expect(receipt['status']).toBe('failed');
    expect(receipt['dispatched']).toBe(true);
    expect(res.stdout).not.toContain('ws://');
  });

  test('oversized screenshot is rejected before the sink write', async () => {
    const h = makeHarness({ limits: { maxArtifactBytes: 4 } });
    const res = await h.bash.exec(`bp screenshot ${h.handleArg} --out /shot.png`);
    expect(res.exitCode).toBe(1);
    expect(lastJson(res.stderr)['error']).toBe('artifact_too_large');
    expect(h.sink.writes).toHaveLength(0);
  });

  test('requires --out', async () => {
    const h = makeHarness();
    const res = await h.bash.exec(`bp screenshot ${h.handleArg}`);
    expect(res.exitCode).toBe(2);
  });
});

describe('capabilities and handle guards', () => {
  test('eval works when granted and returns the result', async () => {
    const h = makeHarness();
    const res = await h.bash.exec(`bp eval ${h.handleArg} '1 + 1'`);
    expect(res.exitCode).toBe(0);
    expect(lastJson(res.stdout)['result']).toBe('evaluated:1 + 1');
  });

  test('denied capability exits 3 with capability JSON', async () => {
    const h = makeHarness({ capabilities: { evaluate: false, action: false, webmcp: false } });
    for (const [cmd, capability] of [
      [`bp eval ${h.handleArg} '1'`, 'evaluate'],
      [`bp click ${h.handleArg} '#go'`, 'action'],
      [`bp webmcp list ${h.handleArg}`, 'webmcp'],
    ] as const) {
      const res = await h.bash.exec(cmd);
      expect(res.exitCode).toBe(3);
      const err = lastJson(res.stderr);
      expect(err['error']).toBe('capability_denied');
      expect(err['capability']).toBe(capability);
    }
    expect(h.connects).toHaveLength(0);
  });

  test('stale generation exits 2 without resolving the session', async () => {
    const h = makeHarness();
    const stale = `'${JSON.stringify(makeHandle({ generation: 'gen-0' }))}'`;
    const res = await h.bash.exec(`bp text ${stale}`);
    expect(res.exitCode).toBe(2);
    expect(lastJson(res.stderr)['error']).toBe('stale_generation');
    expect(h.connects).toHaveLength(0);
  });

  test('expired lease exits 2', async () => {
    const h = makeHarness();
    const expired = `'${JSON.stringify(makeHandle({ leaseExpiresAt: 999 }))}'`;
    const res = await h.bash.exec(`bp goto ${expired} https://x.example/`);
    expect(res.exitCode).toBe(2);
    expect(lastJson(res.stderr)['error']).toBe('lease_expired');
  });

  test('deadline already passed exits 124', async () => {
    const h = makeHarness({ deadline: 1 });
    const res = await h.bash.exec(`bp text ${h.handleArg}`);
    expect(res.exitCode).toBe(124);
    expect(lastJson(res.stderr)['error']).toBe('deadline_exceeded');
  });

  test('deadline crossing during resolve prevents connect and action', async () => {
    let h!: Harness;
    const owner: Partial<SessionOwner> = {
      resolve: async () => {
        h.clock.t = 1_000_010;
        return { wsUrl: SECRET_WS };
      },
    };
    h = makeHarness({ deadline: 1_000_010, owner });
    let clicked = false;
    h.page.onClick = () => {
      clicked = true;
      return true;
    };
    const res = await h.bash.exec(`bp click ${h.handleArg} '#go'`);
    expect(res.exitCode).toBe(124);
    expect(lastJson(res.stderr)['error']).toBe('deadline_exceeded');
    expect(h.connects).toHaveLength(0);
    expect(clicked).toBe(false);
  });

  test('session close remains available after lease expiry', async () => {
    const h = makeHarness();
    const expired = `'${JSON.stringify(makeHandle({ leaseExpiresAt: 999 }))}'`;
    const res = await h.bash.exec(`bp session close ${expired}`);
    expect(res.exitCode).toBe(0);
    expect(lastJson(res.stdout)['status']).toBe('released');
  });

  test('resolve errors never leak the wsUrl', async () => {
    const h = makeHarness({
      owner: {
        resolve: async () => {
          throw new Error(`cannot reach ${SECRET_WS} (token=hunter2)`);
        },
      },
    });
    const res = await h.bash.exec(`bp text ${h.handleArg}`);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).not.toContain('ws://');
    expect(res.stderr).not.toContain('hunter2');
    expect(lastJson(res.stderr)['error']).toBe('resolve_failed');
  });
});

describe('completion budgets and host errors', () => {
  for (const [command, method] of [
    ['text', 'text'],
    ['inspect', 'snapshot'],
    ['eval', 'evaluate'],
    ['webmcp list', 'webmcpList'],
    ['webmcp call', 'webmcpCall'],
  ] as const) {
    for (const cancelled of [false, true]) {
      test(`${command} reports ${cancelled ? 'cancellation' : 'deadline'} after an in-flight result`, async () => {
        let h!: Harness;
        h = makeHarness({
          deadline: 1_000_010,
          pageOverrides: {
            [method]: async () => {
              if (cancelled) h.controller.abort();
              else h.clock.t = 1_000_010;
              return 'late result';
            },
          },
        });
        const res = await h.bash.exec(`bp ${command} ${h.handleArg} value`);
        expect(res.exitCode).toBe(cancelled ? 130 : 124);
        expect(res.stdout).toBe('');
        const error = lastJson(res.stderr);
        expect(error['error']).toBe(cancelled ? 'cancelled' : 'deadline_exceeded');
        expect(error['retrySafe']).toBe(false);
        expect(error['dispatchState']).toBeUndefined();
        expect(h.disconnects).toBe(1);
      });
    }
  }

  test('a read that rejects after its deadline reports deadline rather than runtime failure', async () => {
    let h!: Harness;
    h = makeHarness({
      deadline: 1_000_010,
      pageOverrides: {
        text: async () => {
          h.clock.t = 1_000_010;
          throw new Error('CDP timed out');
        },
      },
    });
    const res = await h.bash.exec(`bp text ${h.handleArg}`);
    expect(res.exitCode).toBe(124);
    expect(lastJson(res.stderr)['error']).toBe('deadline_exceeded');
    expect(h.disconnects).toBe(1);
  });

  for (const [capability, code, exitCode] of [
    ['stale_handle', 'stale_handle', 2],
    ['lease_expired', 'lease_expired', 2],
    ['deadline', 'deadline_exceeded', 124],
    ['secrets', 'capability_denied', 3],
  ] as const) {
    test(`host ${capability} errors retain their documented classification`, async () => {
      const fail = async (): Promise<never> => {
        throw new CapabilityError(capability, `host failure ${SECRET_WS}`);
      };
      const h = makeHarness({
        owner: { open: fail, resolve: fail, release: fail, touch: fail },
      });
      for (const command of [
        'session open',
        `text ${h.handleArg}`,
        `session close ${h.handleArg}`,
        `session touch ${h.handleArg}`,
      ]) {
        const res = await h.bash.exec(`bp ${command}`);
        expect(res.exitCode).toBe(exitCode);
        expect(lastJson(res.stderr)['error']).toBe(code);
        expect(res.stderr).not.toContain(SECRET_WS);
      }
      expect(h.connects).toHaveLength(0);
    });
  }
});

describe('bp actions', () => {
  test('a late action keeps its Page receipt with the deadline exit code', async () => {
    let h!: Harness;
    const receipt = {
      dispatchState: 'dispatched' as const,
      retrySafe: false,
      inputEventsSent: ['mousePressed', 'mouseReleased'],
    };
    h = makeHarness({
      deadline: 1_000_010,
      pageOverrides: {
        click: async () => {
          h.clock.t = 1_000_010;
          return true;
        },
        getLastActionReceipt: () => receipt,
      },
    });
    const res = await h.bash.exec(`bp click ${h.handleArg} '#go'`);
    expect(res.exitCode).toBe(124);
    expect(lastJson(res.stdout)['receipt']).toEqual(receipt);
    expect(res.stderr).toBe('');
    expect(h.disconnects).toBe(1);
  });

  for (const command of ['goto', 'click', 'type'] as const) {
    test(`${command} receives the remaining host timeout at invocation`, async () => {
      let h!: Harness;
      let timeout: number | undefined;
      h = makeHarness({
        deadline: 1_000_100,
        owner: {
          resolve: async () => {
            h.clock.t += 10;
            return { wsUrl: SECRET_WS };
          },
        },
        pageOverrides: {
          url: async () => {
            h.clock.t += 5;
            return h.page.url;
          },
          goto: async (_url, options) => {
            timeout = options?.timeout;
          },
          click: async (_selector, options) => {
            timeout = options?.timeout;
            return true;
          },
          type: async (_selector, _text, options) => {
            timeout = options?.timeout;
            return true;
          },
        },
      });
      const args = command === 'goto' ? 'https://example.com/' : "'#name' hello";
      const res = await h.bash.exec(`bp ${command} ${h.handleArg} ${args}`);
      expect(res.exitCode).toBe(0);
      expect(timeout).toBe(command === 'goto' ? 90 : 85);
    });
  }

  test('click reports Page-compatible dispatch state with url before/after', async () => {
    const h = makeHarness();
    h.page.onClick = () => {
      h.page.url = 'https://example.com/after';
      return true;
    };
    const res = await h.bash.exec(`bp click ${h.handleArg} '#submit'`);
    expect(res.exitCode).toBe(0);
    const out = lastJson(res.stdout);
    expect(out['action']).toBe('click');
    expect(out['target']).toBe('#submit');
    expect(out['dispatchState']).toBe('dispatched');
    expect(out['retrySafe']).toBe(false);
    expect(out['urlBefore']).toBe('https://example.com/');
    expect(out['urlAfter']).toBe('https://example.com/after');
  });

  test('type and press happy paths', async () => {
    const h = makeHarness();
    const typed = await h.bash.exec(`bp type ${h.handleArg} '#name' 'Ada Lovelace'`);
    expect(typed.exitCode).toBe(0);
    expect(lastJson(typed.stdout)['dispatchState']).toBe('dispatched');
    const pressed = await h.bash.exec(`bp press ${h.handleArg} Enter`);
    expect(pressed.exitCode).toBe(0);
    expect(lastJson(pressed.stdout)['target']).toBe('Enter');
  });

  test('cancellation before dispatch reports not_dispatched with exit 130', async () => {
    const h = makeHarness({ preAborted: true });
    const res = await h.bash.exec(`bp click ${h.handleArg} '#go'`);
    expect(res.exitCode).toBe(130);
    const err = lastJson(res.stderr);
    expect(err['error']).toBe('cancelled');
    expect(err['dispatchState']).toBe('not_dispatched');
  });

  test('signal firing after dispatch reports uncertain state with exit 130', async () => {
    const h = makeHarness();
    h.page.onClick = () => {
      h.controller.abort();
      return true;
    };
    const res = await h.bash.exec(`bp click ${h.handleArg} '#go'`);
    expect(res.exitCode).toBe(130);
    const out = lastJson(res.stdout);
    expect(out['dispatchState']).toBe('uncertain');
    expect(out['retrySafe']).toBe(false);
    expect(out['urlBefore']).toBe('https://example.com/');
    expect(out['urlAfter']).toBeUndefined();
  });

  test('action throw after abort is cancelled + uncertain', async () => {
    const h = makeHarness();
    h.page.onClick = () => {
      h.controller.abort();
      throw new Error('socket closed');
    };
    const res = await h.bash.exec(`bp click ${h.handleArg} '#go'`);
    expect(res.exitCode).toBe(130);
    const err = lastJson(res.stderr);
    expect(err['error']).toBe('cancelled');
    expect(err['dispatchState']).toBe('uncertain');
    expect(err['retrySafe']).toBe(false);
  });

  test('action failure without cancellation exits 1', async () => {
    const h = makeHarness();
    h.page.onClick = () => {
      throw new Error('element not interactable');
    };
    const res = await h.bash.exec(`bp click ${h.handleArg} '#go'`);
    expect(res.exitCode).toBe(1);
    const err = lastJson(res.stderr);
    expect(err['error']).toBe('action_failed');
    expect(err['message']).toContain('element not interactable');
  });

  test('false action returns a failed result with not_dispatched state', async () => {
    const h = makeHarness();
    h.page.onClick = () => false;
    const res = await h.bash.exec(`bp click ${h.handleArg} '#go'`);
    expect(res.exitCode).toBe(1);
    const out = lastJson(res.stdout);
    expect(out['result']).toBe(false);
    expect(out['dispatchState']).toBe('not_dispatched');
    expect(out['retrySafe']).toBe(true);
  });
});

describe('bp webmcp', () => {
  test('list prints tools', async () => {
    const h = makeHarness();
    const res = await h.bash.exec(`bp webmcp list ${h.handleArg}`);
    expect(res.exitCode).toBe(0);
    const out = lastJson(res.stdout);
    expect(Array.isArray(out['tools'])).toBe(true);
  });

  test('call passes input from stdin and confirm-mutation flag', async () => {
    const h = makeHarness();
    const res = await h.bash.exec(
      `echo '{"limit":2}' | bp webmcp call ${h.handleArg} get_cart --input - --confirm-mutation`
    );
    expect(res.exitCode).toBe(0);
    const out = lastJson(res.stdout);
    expect(out['tool']).toBe('get_cart');
    expect(out['result']).toEqual({ called: 'get_cart', input: { limit: 2 }, allowMutation: true });
  });

  test('call failure is a runtime error', async () => {
    const h = makeHarness();
    const res = await h.bash.exec(`bp webmcp call ${h.handleArg} nope`);
    expect(res.exitCode).toBe(1);
    expect(lastJson(res.stderr)['message']).toContain('not found');
  });
});

describe('output contract', () => {
  for (const maxOutputBytes of [32, 64]) {
    test(`output above ${maxOutputBytes} bytes fails with bounded JSON and propagates through pipefail`, async () => {
      const h = makeHarness({ limits: { maxOutputBytes } });
      h.page.text = 'x'.repeat(100);
      const res = await h.bash.exec(`set -o pipefail; bp text ${h.handleArg} | jq .`);
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toBe('');
      expect(JSON.parse(res.stderr)).toEqual({ error: 'output_limit' });
      expect(new TextEncoder().encode(res.stderr).byteLength).toBeLessThanOrEqual(maxOutputBytes);
      const chain = await h.bash.exec(`bp text ${h.handleArg} && echo SHOULD_NOT_RUN`);
      expect(chain.exitCode).toBe(1);
      expect(chain.stdout).toBe('');
    });
  }

  test('complete Unicode JSON survives pipes and redirection below the hard cap', async () => {
    const h = makeHarness({ limits: { maxOutputBytes: 4096 } });
    h.page.text = 'Hello 🌍 世界'.repeat(100);
    const res = await h.bash.exec(
      `set -o pipefail; bp text ${h.handleArg} | jq . > /page.json && cat /page.json`
    );
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ text: h.page.text });
    expect(res.stderr).toBe('');
  });

  test('oversize errors are replaced with a complete bounded error', async () => {
    const h = makeHarness({
      limits: { maxOutputBytes: 32 },
      owner: {
        resolve: async () => {
          throw new Error('x'.repeat(100));
        },
      },
    });
    const res = await h.bash.exec(`bp text ${h.handleArg}`);
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stderr)).toEqual({ error: 'output_limit' });
    expect(res.stderr.length).toBeLessThanOrEqual(32);
  });

  test('bp --help lists commands with capabilities and native-only note', async () => {
    const h = makeHarness();
    const res = await h.bash.exec('bp --help');
    expect(res.exitCode).toBe(0);
    for (const name of [
      'session open',
      'goto',
      'tabs',
      'inspect',
      'text',
      'screenshot',
      'eval',
      'click',
      'webmcp call',
    ]) {
      expect(res.stdout).toContain(name);
    }
    expect(res.stdout).toContain('[evaluate');
    expect(res.stdout).toContain('Native-only');
    expect(res.stdout).toContain('Exit codes');
  });

  test('per-command help works via --help and help topic', async () => {
    const h = makeHarness();
    const viaFlag = await h.bash.exec('bp screenshot --help');
    expect(viaFlag.stdout).toContain('--out PATH');
    const viaTopic = await h.bash.exec('bp help webmcp call');
    expect(viaTopic.stdout).toContain('--confirm-mutation');
  });

  test('help pipes through shell tools', async () => {
    const h = makeHarness();
    const res = await h.bash.exec('bp --help | grep -c capability');
    expect(res.exitCode).toBe(0);
    expect(Number(res.stdout.trim())).toBeGreaterThan(0);
  });

  test('unknown command is a usage error', async () => {
    const h = makeHarness();
    const res = await h.bash.exec('bp frobnicate');
    expect(res.exitCode).toBe(2);
    expect(lastJson(res.stderr)['error']).toBe('usage');
  });
});
