/**
 * Adversarial consumer tests for the just-bash `bp` bridge.
 *
 * Perspective: a trusted Cloudflare Worker host embeds a sandboxed just-bash
 * shell for an AI agent and wires `registerBrowserPilotCommands(ports)`. The
 * agent (shell user) is hostile: it forges handles, probes for credential
 * leaks, tries capability escalation, floods outputs, and races cancellation.
 *
 * Composition — real pieces only, per the harness style of
 * tests/unit/just-bash-commands.test.ts and just-bash-e2e-inprocess.test.ts:
 *   - real `just-bash` `Bash` (VFS, pipes, env, symlinks, substitution)
 *   - real `MemorySessionOwner` + `FakeClock` + `MemoryArtifactSink`
 *     (src/adapters/memory — same generation-fencing contract as
 *     InProcessSessionOwner)
 *   - injected fake `connect` factory (no CDP, counts every page call)
 *
 * Output above the host cap fails with bounded JSON; streams are never sliced.
 * Oversize screenshots fail before storage, and provider credentials stay in the host.
 */

import { describe, expect, test } from 'bun:test';
import { Bash } from 'just-bash';
import {
  FakeClock,
  MemoryArtifactSink,
  MemorySessionOwner,
} from '../../src/adapters/memory/index.ts';
import type { SessionOwner } from '../../src/just-bash/index.ts';
import { registerBrowserPilotCommands } from '../../src/just-bash/index.ts';
import type { BpBrowser, BpPage, BrowserPilotJustBashPorts } from '../../src/just-bash/types.ts';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const SECRET = 'SECRET123';
const SECRET_WS = `wss://connect.provider.example/devtools/browser/abc?apiKey=${SECRET}&sig=${SECRET}`;
const GENERATION = 'adv-gen-1';
const NOW = 1_000_000;

const MiB = 1024 * 1024;

/** Shell-quote a string for just-bash (single quotes). */
function q(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function lastJson(text: string): Record<string, unknown> {
  const line = text.trim().split('\n').pop() ?? '';
  const value: unknown = JSON.parse(line);
  if (typeof value !== 'object' || value === null) throw new Error(`expected JSON object: ${line}`);
  return value as Record<string, unknown>;
}

function byteLen(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('until(): timeout');
    await new Promise((r) => setTimeout(r, 1));
  }
}

// ---------------------------------------------------------------------------
// fake browser (counts every dangerous call)
// ---------------------------------------------------------------------------

interface Counters {
  connects: string[];
  disconnects: number;
  gotos: number;
  evals: number;
  clicks: number;
  types: number;
  presses: number;
  webmcpCalls: number;
}

interface PageState {
  url: string;
  title: string;
  text: string;
  screenshotBase64: string;
  onClick?: () => Promise<boolean> | boolean;
}

const TINY_PNG = (() => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
})();

function fakePage(state: PageState, counters: Counters): BpPage {
  return {
    async goto(url) {
      counters.gotos++;
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
      return state.screenshotBase64;
    },
    async evaluate(expression) {
      counters.evals++;
      return `evaluated:${expression}`;
    },
    async click() {
      counters.clicks++;
      return (await state.onClick?.()) ?? true;
    },
    async type() {
      counters.types++;
      return true;
    },
    async press() {
      counters.presses++;
    },
    async webmcpList(fromOrigins) {
      return { status: { available: true }, tools: [{ name: 'get_cart', fromOrigins }] };
    },
    async webmcpCall(name, input, options) {
      counters.webmcpCalls++;
      if (name !== 'get_cart') throw new Error(`tool ${name} not found`);
      return { called: name, input: input ?? null, allowMutation: options?.allowMutation ?? false };
    },
  };
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface Harness {
  bash: Bash;
  clock: FakeClock;
  sink: ReturnType<typeof MemoryArtifactSink>;
  owner: MemorySessionOwner;
  page: PageState;
  counters: Counters;
  controller: AbortController;
  /** `bp session open` through the shell; returns the handle object + quoted arg. */
  open(provider?: string): Promise<{ handle: Record<string, unknown>; arg: string }>;
}

function makeHarness(
  options: {
    capabilities?: Partial<BrowserPilotJustBashPorts['capabilities']>;
    limits?: BrowserPilotJustBashPorts['limits'];
    deadline?: number;
    preAborted?: boolean;
    files?: Record<string, string>;
    ownerOverride?: SessionOwner;
    connectError?: Error;
  } = {}
): Harness {
  const clock = new FakeClock(NOW);
  const sink = MemoryArtifactSink();
  const owner = new MemorySessionOwner({ wsUrl: SECRET_WS });
  const page: PageState = {
    url: 'https://example.com/',
    title: 'Example',
    text: 'Hello world',
    screenshotBase64: TINY_PNG,
  };
  const counters: Counters = {
    connects: [],
    disconnects: 0,
    gotos: 0,
    evals: 0,
    clicks: 0,
    types: 0,
    presses: 0,
    webmcpCalls: 0,
  };
  const controller = new AbortController();
  if (options.preAborted) controller.abort();

  const browser: BpBrowser = {
    async page() {
      return fakePage(page, counters);
    },
    async listTargets() {
      return [{ targetId: 't1', type: 'page', url: page.url, title: page.title }];
    },
    async disconnect() {
      counters.disconnects++;
    },
  };

  const ports: BrowserPilotJustBashPorts = {
    sessionOwner: options.ownerOverride ?? owner,
    artifacts: sink,
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
      counters.connects.push(wsUrl);
      if (options.connectError) throw options.connectError;
      return browser;
    },
  };

  const bash = new Bash({
    customCommands: registerBrowserPilotCommands(ports),
    files: options.files ?? {},
    // Bun cannot apply just-bash's Node-specific defense-in-depth patches.
    defenseInDepth: false,
  });

  return {
    bash,
    clock,
    sink,
    owner,
    page,
    counters,
    controller,
    async open(provider = 'generic') {
      const res = await bash.exec(`bp session open --provider ${provider}`);
      if (res.exitCode !== 0) throw new Error(`session open failed: ${res.stderr}`);
      const handle = lastJson(res.stdout);
      return { handle, arg: q(JSON.stringify(handle)) };
    },
  };
}

function expectNoLeak(res: { stdout: string; stderr: string }, label: string): void {
  for (const [chan, text] of [
    ['stdout', res.stdout],
    ['stderr', res.stderr],
  ] as const) {
    if (text.includes(SECRET)) {
      throw new Error(`[${label}] ${chan} leaked SECRET: ${text.slice(0, 500)}`);
    }
    if (text.includes(SECRET_WS) || /wss:\/\//i.test(text)) {
      throw new Error(`[${label}] ${chan} leaked wsUrl: ${text.slice(0, 500)}`);
    }
  }
}

// ===========================================================================
// 1. Credential leakage
// ===========================================================================

describe('1. credential leakage', () => {
  test('no command output ever contains the wsUrl or the apiKey', async () => {
    const h = makeHarness();
    const { arg } = await h.open();
    const stale = q(JSON.stringify({ id: 'memory-session-1', generation: 'old', provider: 'x' }));

    const commands = [
      'bp --help',
      'bp help eval',
      'bp help session open',
      'bp session open --provider browserbase',
      `bp session touch ${arg}`, // MemorySessionOwner has no touch → unsupported, exit 1
      `bp goto ${arg} https://target.example/`,
      `bp tabs ${arg}`,
      `bp tabs ${arg} --format text`,
      `bp inspect ${arg}`,
      `bp text ${arg}`,
      `bp text ${arg} --format text | cat`,
      `bp screenshot ${arg} --out shots/a.png`,
      `bp screenshot ${arg} --out /abs.png`, // sink rejects absolute → failed receipt
      `bp eval ${arg} 'document.title'`,
      `bp click ${arg} '#go'`,
      `bp type ${arg} '#name' hostile`,
      `bp press ${arg} Enter`,
      `bp webmcp list ${arg}`,
      `bp webmcp call ${arg} get_cart --input '{"x":1}'`,
      `bp webmcp call ${arg} get_cart --input 'not json'`, // usage error
      'bp frobnicate', // unknown subcommand
      `bp text 'not-a-json-handle'`, // bad handle JSON
      `bp text '{"id":42}'`, // malformed handle
      `bp text ${stale}`, // stale generation
      `bp text --handle-file /does/not/exist`,
      `bp session close ${arg}`,
      `bp session close ${arg}`, // second close → already_released
      `bp text ${arg}`, // resolve of released handle → stale_handle error
    ];

    for (const cmd of commands) {
      const res = await h.bash.exec(cmd);
      expectNoLeak(res, cmd);
    }
  });

  test('resolve() rejection embedding the wsUrl is sanitized', async () => {
    const owner = new MemorySessionOwner({ wsUrl: SECRET_WS });
    const throwing: SessionOwner = {
      open: (o, c) => owner.open(o, c),
      resolve: async () => {
        throw new Error(`cannot reach ${SECRET_WS} (token=${SECRET})`);
      },
      release: (hd, c) => owner.release(hd, c),
    };
    const h = makeHarness({ ownerOverride: throwing });
    const { arg } = await h.open();
    const res = await h.bash.exec(`bp text ${arg}`);
    expect(res.exitCode).toBe(1);
    expect(lastJson(res.stderr)['error']).toBe('resolve_failed');
    expectNoLeak(res, 'resolve throw');
  });

  test('connect() rejection embedding the wsUrl is sanitized', async () => {
    const h = makeHarness({
      connectError: new Error(`ECONNREFUSED ${SECRET_WS} apiKey=${SECRET}`),
    });
    const { arg } = await h.open();
    const res = await h.bash.exec(`bp goto ${arg} https://x.example/`);
    expect(res.exitCode).toBe(1);
    expect(lastJson(res.stderr)['error']).toBe('connect_failed');
    expectNoLeak(res, 'connect throw');
  });

  test('page action failure embedding the wsUrl is sanitized', async () => {
    const h = makeHarness();
    h.page.onClick = () => {
      throw new Error(`socket to ${SECRET_WS} closed`);
    };
    const { arg } = await h.open();
    const res = await h.bash.exec(`bp click ${arg} '#go'`);
    expect(res.exitCode).toBe(1);
    expect(lastJson(res.stderr)['error']).toBe('action_failed');
    expectNoLeak(res, 'action throw');
  });

  test('aborted ctx and denied capability outputs are leak-free', async () => {
    const aborted = makeHarness({ preAborted: true });
    const handleJson = JSON.stringify({
      id: 'memory-session-1',
      generation: GENERATION,
      provider: 'generic',
    });
    const abortedRes = await aborted.bash.exec(`bp text ${q(handleJson)}`);
    expect(abortedRes.exitCode).toBe(130);
    expectNoLeak(abortedRes, 'aborted ctx');

    const denied = makeHarness({
      capabilities: { evaluate: false, action: false, webmcp: false },
    });
    const { arg } = await denied.open();
    for (const cmd of [`bp eval ${arg} '1'`, `bp click ${arg} x`, `bp webmcp list ${arg}`]) {
      const res = await denied.bash.exec(cmd);
      expect(res.exitCode).toBe(3);
      expectNoLeak(res, cmd);
    }
  });

  test('owner returning extra credential fields on the handle is whitelisted away', async () => {
    const inner = new MemorySessionOwner({ wsUrl: SECRET_WS });
    const leakyOwner: SessionOwner = {
      async open(o, c) {
        const handle = await inner.open(o, c);
        // Hostile/buggy host returns credentials on the handle object.
        return { ...handle, wsUrl: SECRET_WS, apiKey: SECRET } as typeof handle;
      },
      resolve: (hd, c) => inner.resolve(hd, c),
      release: (hd, c) => inner.release(hd, c),
      async touch(hd, _c) {
        return { ...hd, leaseExpiresAt: NOW + 1000, wsUrl: SECRET_WS } as typeof hd;
      },
    };
    const h = makeHarness({ ownerOverride: leakyOwner });
    const openRes = await h.bash.exec('bp session open --provider generic');
    expect(openRes.exitCode).toBe(0);
    expectNoLeak(openRes, 'session open whitelist');
    const handle = lastJson(openRes.stdout);
    expect(Object.keys(handle).sort()).toEqual(['generation', 'id', 'provider', 'sessionId']);

    const touchRes = await h.bash.exec(`bp session touch ${q(JSON.stringify(handle))}`);
    expect(touchRes.exitCode).toBe(0);
    expectNoLeak(touchRes, 'session touch whitelist');
    expect(Object.keys(lastJson(touchRes.stdout)).sort()).toEqual([
      'generation',
      'id',
      'leaseExpiresAt',
      'provider',
      'sessionId',
    ]);
  });
});

// ===========================================================================
// 2. Handle forgery
// ===========================================================================

describe('2. handle forgery', () => {
  test('id of another (nonexistent) session → clean stale-handle error, no crash', async () => {
    const h = makeHarness();
    await h.open();
    const forged = q(
      JSON.stringify({ id: 'memory-session-999', generation: GENERATION, provider: 'generic' })
    );
    const res = await h.bash.exec(`bp text ${forged}`);
    expect(res.exitCode).toBe(2);
    expect(lastJson(res.stderr)['error']).toBe('stale_handle');
    expectNoLeak(res, 'forged id');
  });

  test('tampered generation → exit 2 stale_generation without resolving', async () => {
    const h = makeHarness();
    const { handle } = await h.open();
    const resolvedBefore = h.owner.resolvedHandles.length;
    const res = await h.bash.exec(
      `bp text ${q(JSON.stringify({ ...handle, generation: 'gen-evil' }))}`
    );
    expect(res.exitCode).toBe(2);
    expect(lastJson(res.stderr)['error']).toBe('stale_generation');
    expect(h.owner.resolvedHandles.length).toBe(resolvedBefore);
  });

  test('extra fields are stripped before reaching the SessionOwner', async () => {
    const h = makeHarness();
    const { handle } = await h.open();
    const forged = {
      ...handle,
      wsUrl: 'wss://attacker.example/?apiKey=INJECTED',
      admin: true,
      capabilities: { evaluate: true },
    };
    const res = await h.bash.exec(`bp text ${q(JSON.stringify(forged))}`);
    expect(res.exitCode).toBe(0);
    const seen = h.owner.resolvedHandles.at(-1);
    expect(seen).toBeDefined();
    expect(Object.keys(seen ?? {}).sort()).toEqual(['generation', 'id', 'provider', 'sessionId']);
    expect((seen as unknown as Record<string, unknown>)['wsUrl']).toBeUndefined();
  });

  test('__proto__ / constructor keys do not pollute prototypes', async () => {
    const h = makeHarness();
    const { handle } = await h.open();
    const polluted =
      `{"__proto__":{"hacked":true},` +
      `"constructor":{"prototype":{"hacked2":true}},` +
      `"id":${JSON.stringify(handle['id'])},` +
      `"generation":${JSON.stringify(handle['generation'])},` +
      `"provider":"generic"}`;
    const res = await h.bash.exec(`bp text ${q(polluted)}`);
    expect(res.exitCode).toBe(0);
    const probe = {} as Record<string, unknown>;
    expect(probe['hacked']).toBeUndefined();
    expect(probe['hacked2']).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)['hacked']).toBeUndefined();
    // The parsed handle passed to resolve() must not carry a forged prototype.
    const seen = h.owner.resolvedHandles.at(-1) as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(seen)).toBe(Object.prototype);
    expect(seen['hacked']).toBeUndefined();
  });

  test('huge string fields → clean usage exit, stderr bounded ([NOTE-2] fixed)', async () => {
    const maxOutputBytes = 4096;
    const h = makeHarness({ limits: { maxOutputBytes } });
    await h.open();
    const hugeId = 'A'.repeat(300_000);
    const res = await h.bash.exec(
      `bp text ${q(JSON.stringify({ id: hugeId, generation: GENERATION, provider: 'generic' }))}`
    );
    // parseHandle clamps string fields to 256 chars → usage error, exit 2,
    // before the huge id ever reaches the SessionOwner or an error message.
    expect(res.exitCode).toBe(2);
    expect(lastJson(res.stderr)['error']).toBe('usage');
    expectNoLeak(res, 'huge id');
    // Oversize stderr is replaced with a bounded structured error.
    expect(byteLen(res.stderr)).toBeLessThanOrEqual(maxOutputBytes);
  });

  test('non-JSON / non-object / wrong-typed handles → usage exit 2', async () => {
    const h = makeHarness();
    for (const bad of [
      `bp text not-json`,
      `bp text '[1,2]'`,
      `bp text 'null'`,
      `bp text '"str"'`,
      `bp text '42'`,
      `bp text '{"id":1,"generation":"g","provider":"p"}'`,
      `bp text '{"id":"x","generation":"g","provider":"p","leaseExpiresAt":"soon"}'`,
      `bp text '{"id":"x","generation":"g","provider":"p","sessionId":7}'`,
    ]) {
      const res = await h.bash.exec(bad);
      expect(res.exitCode).toBe(2);
      expect(lastJson(res.stderr)['error']).toBe('usage');
    }
    expect(h.counters.connects).toHaveLength(0);
  });

  test('--handle-file traversal and missing paths → usage exit 2', async () => {
    const h = makeHarness();
    for (const path of [
      '../../../../etc/passwd',
      '/../../../secret.json',
      '/nope/handle.json',
      '..',
    ]) {
      const res = await h.bash.exec(`bp text --handle-file ${q(path)}`);
      expect(res.exitCode).toBe(2);
      expectNoLeak(res, `handle-file ${path}`);
    }
  });

  test('--handle-file via VFS symlink resolves cleanly', async () => {
    const h = makeHarness();
    const { handle } = await h.open();
    const write = await h.bash.exec(`echo ${q(JSON.stringify(handle))} > /h.json`);
    expect(write.exitCode).toBe(0);
    const ln = await h.bash.exec('ln -s /h.json /link.json');
    expect(ln.exitCode).toBe(0);
    const res = await h.bash.exec('bp text --handle-file /link.json');
    // Either the VFS follows the symlink (exit 0) or refuses (usage exit 2);
    // both are clean. It must never crash or leak.
    expect([0, 2]).toContain(res.exitCode);
    expectNoLeak(res, 'symlinked handle file');
    if (res.exitCode === 0) expect(lastJson(res.stdout)['text']).toBe('Hello world');
  });
});

// ===========================================================================
// 3. Capability escalation
// ===========================================================================

describe('3. capability escalation (read-only policy)', () => {
  async function readOnly(): Promise<{ h: Harness; arg: string }> {
    const h = makeHarness({ capabilities: { evaluate: false, action: false, webmcp: false } });
    const { arg } = await h.open();
    return { h, arg };
  }

  test('eval / click / webmcp call are denied with exit 3 and never dispatched', async () => {
    const { h, arg } = await readOnly();
    const connectsAfterOpen = h.counters.connects.length;
    for (const [cmd, capability] of [
      [`bp eval ${arg} 'fetch("https://evil")'`, 'evaluate'],
      [`bp click ${arg} '#buy'`, 'action'],
      [`bp type ${arg} '#pw' hunter2`, 'action'],
      [`bp press ${arg} Enter`, 'action'],
      [`bp webmcp call ${arg} get_cart --input '{}' --confirm-mutation`, 'webmcp'],
      [`bp webmcp list ${arg}`, 'webmcp'],
    ] as const) {
      const res = await h.bash.exec(cmd);
      expect(res.exitCode).toBe(3);
      const err = lastJson(res.stderr);
      expect(err['error']).toBe('capability_denied');
      expect(err['capability']).toBe(capability);
    }
    expect(h.counters.evals).toBe(0);
    expect(h.counters.clicks).toBe(0);
    expect(h.counters.types).toBe(0);
    expect(h.counters.presses).toBe(0);
    expect(h.counters.webmcpCalls).toBe(0);
    expect(h.counters.connects.length).toBe(connectsAfterOpen);
  });

  test('smuggling via env / shell vars / pipes / substitution still exits 3', async () => {
    const { h, arg } = await readOnly();
    const attempts = [
      `env CAP=evaluate bp eval ${arg} '1+1'`,
      `X=eval; bp $X ${arg} '1+1'`,
      `bp $(echo click) ${arg} '#buy'`,
      `echo '1+1' | bp eval ${arg} -`,
      `bp text ${arg} | bp eval ${arg} -`, // pipeline exit = last command
      `true && bp click ${arg} '#buy'`,
      `bp eval ${arg} '1' || bp eval ${arg} '2'`,
    ];
    for (const cmd of attempts) {
      const res = await h.bash.exec(cmd);
      expect(res.exitCode).toBe(3);
    }
    expect(h.counters.evals).toBe(0);
    expect(h.counters.clicks).toBe(0);
  });
});

// ===========================================================================
// 4. Output bounds
// ===========================================================================

describe('4. output bounds', () => {
  test('5 MiB page text fails within the hard output cap', async () => {
    const maxOutputBytes = 64 * 1024;
    const h = makeHarness({ limits: { maxOutputBytes } });
    h.page.text = 'x'.repeat(5 * MiB);
    const { arg } = await h.open();
    const res = await h.bash.exec(`bp text ${arg}`);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe('');
    expect(JSON.parse(res.stderr)).toEqual({ error: 'output_limit' });
    expect(byteLen(res.stderr)).toBeLessThanOrEqual(maxOutputBytes);
  });

  test('3 MiB screenshot vs 1 MiB maxArtifactBytes → structured oversize error, nothing stored', async () => {
    const h = makeHarness({ limits: { maxArtifactBytes: 1 * MiB } });
    // 4 MiB of base64 'A' decodes to 3 MiB of zero bytes.
    h.page.screenshotBase64 = 'A'.repeat(4 * MiB);
    const { arg } = await h.open();
    const res = await h.bash.exec(`bp screenshot ${arg} --out shots/big.png`);
    // [NOTE-3] The adapter rejects BEFORE the sink write with a structured
    // stderr error (not a stdout receipt, not an unhandled throw).
    expect(res.exitCode).toBe(1);
    const err = lastJson(res.stderr);
    expect(err['error']).toBe('artifact_too_large');
    expect(h.sink.store.size).toBe(0);
    expectNoLeak(res, 'oversize screenshot');
  });

  test('sink-level failure (absolute path) is a receipt, not a throw', async () => {
    const h = makeHarness();
    const { arg } = await h.open();
    const res = await h.bash.exec(`bp screenshot ${arg} --out /abs/path.png`);
    expect(res.exitCode).toBe(1);
    const receipt = lastJson(res.stdout);
    expect(receipt['status']).toBe('failed');
    expect(h.sink.store.size).toBe(0);
  });
});

// ===========================================================================
// 5. Cancellation
// ===========================================================================

describe('5. cancellation', () => {
  test('abort before action → not_dispatched, exit 130, zero page calls', async () => {
    const h = makeHarness();
    const { arg } = await h.open();
    const connectsAfterOpen = h.counters.connects.length;
    h.controller.abort();
    const res = await h.bash.exec(`bp click ${arg} '#go'`);
    expect(res.exitCode).toBe(130);
    const err = lastJson(res.stderr);
    expect(err['error']).toBe('cancelled');
    expect(err['dispatchState']).toBe('not_dispatched');
    expect(h.counters.clicks).toBe(0);
    expect(h.counters.connects.length).toBe(connectsAfterOpen);
  });

  test('abort during dispatch → uncertain, exactly one click, no retry', async () => {
    const h = makeHarness();
    const { arg } = await h.open();
    let resolveClick: (() => void) | undefined;
    h.page.onClick = () =>
      new Promise<boolean>((resolve) => {
        resolveClick = () => resolve(true);
      });

    const pending = h.bash.exec(`bp click ${arg} '#go'`);
    await until(() => h.counters.clicks === 1);
    h.controller.abort(); // signal fires while the click is in flight
    resolveClick?.();
    const res = await pending;

    expect(res.exitCode).toBe(130);
    const out = lastJson(res.stdout);
    expect(out['dispatchState']).toBe('uncertain');
    expect(out['urlAfter']).toBeUndefined();
    expect(h.counters.clicks).toBe(1); // never re-dispatched
    expectNoLeak(res, 'mid-dispatch abort');
  });

  test('click rejecting after abort → cancelled + uncertain, one click', async () => {
    const h = makeHarness();
    const { arg } = await h.open();
    let rejectClick: ((e: Error) => void) | undefined;
    h.page.onClick = () =>
      new Promise<boolean>((_res, reject) => {
        rejectClick = reject;
      });
    const pending = h.bash.exec(`bp click ${arg} '#go'`);
    await until(() => h.counters.clicks === 1);
    h.controller.abort();
    rejectClick?.(new Error(`ws ${SECRET_WS} torn down`));
    const res = await pending;
    expect(res.exitCode).toBe(130);
    const err = lastJson(res.stderr);
    expect(err['error']).toBe('cancelled');
    expect(err['dispatchState']).toBe('uncertain');
    expect(h.counters.clicks).toBe(1);
    expectNoLeak(res, 'reject after abort');
  });
});

// ===========================================================================
// 6. Deadline / lease
// ===========================================================================

describe('6. deadline and lease fencing', () => {
  test('leaseExpiresAt in the past (per FakeClock) → exit 2 lease_expired, no resolve', async () => {
    const h = makeHarness();
    const { handle } = await h.open();
    const resolvedBefore = h.owner.resolvedHandles.length;
    for (const lease of [NOW - 1, NOW]) {
      // boundary: lease == now is also expired
      const res = await h.bash.exec(
        `bp goto ${q(JSON.stringify({ ...handle, leaseExpiresAt: lease }))} https://x.example/`
      );
      expect(res.exitCode).toBe(2);
      expect(lastJson(res.stderr)['error']).toBe('lease_expired');
    }
    expect(h.owner.resolvedHandles.length).toBe(resolvedBefore);
  });

  test('lease valid now but expired after FakeClock advance', async () => {
    const h = makeHarness();
    const { handle } = await h.open();
    const arg = q(JSON.stringify({ ...handle, leaseExpiresAt: NOW + 500 }));
    expect((await h.bash.exec(`bp text ${arg}`)).exitCode).toBe(0);
    h.clock.advance(500);
    const res = await h.bash.exec(`bp text ${arg}`);
    expect(res.exitCode).toBe(2);
    expect(lastJson(res.stderr)['error']).toBe('lease_expired');
  });

  test('deadline already passed → exit 124', async () => {
    const h = makeHarness({ deadline: NOW - 1 });
    const handleJson = JSON.stringify({
      id: 'memory-session-1',
      generation: GENERATION,
      provider: 'generic',
    });
    const res = await h.bash.exec(`bp text ${q(handleJson)}`);
    expect(res.exitCode).toBe(124);
    expect(lastJson(res.stderr)['error']).toBe('deadline_exceeded');
  });
});

// ===========================================================================
// 7. Concurrency
// ===========================================================================

describe('7. concurrency', () => {
  test('5 concurrent commands on one handle: no cross-talk, each output valid JSON', async () => {
    const h = makeHarness();
    const { arg } = await h.open();
    const selectors = ['#s1', '#s2', '#s3', '#s4', '#s5'];
    const results = await Promise.all(
      selectors.map((sel) => h.bash.exec(`bp text ${arg} ${q(sel)}`))
    );
    for (const [i, res] of results.entries()) {
      expect(res.exitCode).toBe(0);
      const out = lastJson(res.stdout); // throws if not valid JSON
      expect(out['text']).toBe(`[${selectors[i]}] Hello world`);
      // exactly one JSON line — no interleaved fragments from siblings
      expect(res.stdout.trim().split('\n')).toHaveLength(1);
    }
    // one connect + one disconnect per invocation, none shared/leaked
    expect(h.counters.connects.length).toBeGreaterThanOrEqual(selectors.length);
    expect(h.counters.disconnects).toBe(h.counters.connects.length);
  });

  test('mixed concurrent commands stay isolated', async () => {
    const h = makeHarness();
    const { arg } = await h.open();
    const [t, tabs, snap, ev, help] = await Promise.all([
      h.bash.exec(`bp text ${arg}`),
      h.bash.exec(`bp tabs ${arg}`),
      h.bash.exec(`bp inspect ${arg}`),
      h.bash.exec(`bp eval ${arg} '40+2'`),
      h.bash.exec('bp --help'),
    ]);
    expect(lastJson(t.stdout)['text']).toBe('Hello world');
    expect(Array.isArray(lastJson(tabs.stdout)['targets'])).toBe(true);
    expect(lastJson(snap.stdout)['interactiveElements']).toEqual([{ ref: 'e1' }]);
    expect(lastJson(ev.stdout)['result']).toBe('evaluated:40+2');
    expect(help.stdout).toContain('Exit codes');
    for (const res of [t, tabs, snap, ev, help]) expect(res.exitCode).toBe(0);
  });
});

// ===========================================================================
// 8. Session close idempotency
// ===========================================================================

describe('8. session close idempotency', () => {
  test('double close: released once, then already_released; provider released exactly once', async () => {
    const h = makeHarness();
    const { arg } = await h.open();

    const first = await h.bash.exec(`bp session close ${arg}`);
    expect(first.exitCode).toBe(0);
    expect(lastJson(first.stdout)['status']).toBe('released');

    const second = await h.bash.exec(`bp session close ${arg}`);
    expect(second.exitCode).toBe(0);
    expect(lastJson(second.stdout)['status']).toBe('already_released');

    // MemorySessionOwner records both release attempts, but only the first
    // one actually deleted the live session (the provider-close analog).
    expect(h.owner.releasedHandles).toHaveLength(2);
    const statuses = [lastJson(first.stdout)['status'], lastJson(second.stdout)['status']];
    expect(statuses.filter((s) => s === 'released')).toHaveLength(1);
  });

  test('commands after close fail cleanly and never dial out', async () => {
    const h = makeHarness();
    const { arg } = await h.open();
    await h.bash.exec(`bp session close ${arg}`);
    const connectsAfterClose = h.counters.connects.length;
    const res = await h.bash.exec(`bp goto ${arg} https://x.example/`);
    expect(res.exitCode).toBe(2); // stale handle from the owner
    expect(h.counters.connects.length).toBe(connectsAfterClose);
  });
});

// ===========================================================================
// 9. Unicode round-trips
// ===========================================================================

describe('9. unicode', () => {
  test('emoji/CJK URL survives goto → output round-trip', async () => {
    const h = makeHarness();
    const { arg } = await h.open();
    const url = 'https://例え.jp/パス/検索?q=🚀🦊&emoji=👩‍👩‍👧‍👦';
    const res = await h.bash.exec(`bp goto ${arg} ${q(url)}`);
    expect(res.exitCode).toBe(0);
    const out = lastJson(res.stdout);
    expect(out['url']).toBe(url);
    expect(h.page.url).toBe(url);
  });

  test('emoji/CJK page text round-trips via JSON, --format text, and pipes', async () => {
    const h = makeHarness();
    h.page.text = '🦊 こんにちは 世界 🌏 — ünïcödé ✓ 𝔊𝔬𝔱𝔥𝔦𝔠';
    const { arg } = await h.open();

    const asJson = await h.bash.exec(`bp text ${arg}`);
    expect(lastJson(asJson.stdout)['text']).toBe(h.page.text);

    const asText = await h.bash.exec(`bp text ${arg} --format text`);
    expect(asText.stdout).toBe(`${h.page.text}\n`);

    const piped = await h.bash.exec(`bp text ${arg} --format text | cat`);
    expect(piped.stdout).toContain('こんにちは');
    expect(piped.stdout).toContain('🌏');
    expect(piped.stdout).toContain('𝔊𝔬𝔱𝔥𝔦𝔠');
  });

  test('oversize Unicode output fails without partial UTF-8 or JSON', async () => {
    const h = makeHarness({ limits: { maxOutputBytes: 160 } });
    h.page.text = '🌍'.repeat(200);
    const { arg } = await h.open();
    const res = await h.bash.exec(`bp text ${arg}`);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toBe('');
    expect(JSON.parse(res.stderr)).toEqual({ error: 'output_limit' });
  });
});
