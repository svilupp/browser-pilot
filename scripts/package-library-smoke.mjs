// Run from inside the extracted package to exercise its actual subpath exports.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as esm from 'browser-pilot';
import * as esmBrowser from 'browser-pilot/browser';
import * as esmCore from 'browser-pilot/core';
import * as esmJustBash from 'browser-pilot/just-bash';
import * as esmProviders from 'browser-pilot/providers';

const require = createRequire(import.meta.url);
const originalFetch = globalThis.fetch;
try {
  for (const [format, root, providers, browser, core, justBash] of [
    ['esm', esm, esmProviders, esmBrowser, esmCore, esmJustBash],
    [
      'cjs',
      require('browser-pilot'),
      require('browser-pilot/providers'),
      require('browser-pilot/browser'),
      require('browser-pilot/core'),
      undefined,
    ],
  ]) {
    assert.equal(root.Browser, browser.Browser, `${format}: subpaths must share class identity`);
    assert.equal(root.CapabilityError, core.CapabilityError, `${format}: CapabilityError identity`);
    if (justBash) {
      assert.equal(
        justBash.CapabilityError,
        core.CapabilityError,
        `${format}: just-bash CapabilityError identity`
      );
    }
    for (const name of ['webmcpCall', 'webmcpList', 'mintCfAccessJwt', 'getBuildProvenance']) {
      assert.equal(typeof root[name], 'function', `${format}: Flightplan requires ${name}`);
    }
    root.setEnvOverrides({
      BROWSERBASE_API_KEY: 'package-smoke-key',
      BROWSERBASE_PROJECT_ID: 'project',
    });
    try {
      globalThis.fetch = async (_url, init) => {
        assert.equal(new Headers(init?.headers).get('X-BB-API-Key'), 'package-smoke-key');
        return Response.json({
          id: 'package-smoke',
          projectId: 'project',
          status: 'RUNNING',
          connectUrl: 'wss://example.invalid',
        });
      };
      const provider = providers.createProvider({ provider: 'browserbase' });
      assert.equal((await provider.createSession()).sessionId, 'package-smoke');
    } finally {
      root.clearEnvOverrides();
    }
  }
} finally {
  globalThis.fetch = originalFetch;
}

/**
 * Build and run a consumer that imports only Browser. This catches the
 * package.json `sideEffects: false` failure mode where a bundler drops the
 * convenience connect module and thereby loses the root env fallback.
 */
function runBundledConsumer(name, source, env = {}) {
  const directory = mkdtempSync(join(process.cwd(), `.package-${name}-`));
  const input = join(directory, 'consumer.mjs');
  const output = join(directory, 'consumer.bundle.mjs');
  writeFileSync(input, source);
  try {
    execFileSync(
      'bun',
      ['build', input, '--bundle', '--format=esm', '--target=node', '--outfile', output],
      { cwd: process.cwd(), stdio: 'pipe' }
    );
    execFileSync('node', [output], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

runBundledConsumer(
  'browser-env',
  `
import { Browser } from 'browser-pilot';

const equal = (actual, expected, message) => {
  if (actual !== expected) throw new Error(message ?? 'assertion failed');
};

class SmokeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = SmokeWebSocket.CONNECTING;
  listeners = new Map();
  constructor() {
    queueMicrotask(() => {
      this.readyState = SmokeWebSocket.OPEN;
      this.emit('open');
    });
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  send(raw) {
    const message = JSON.parse(raw);
    if (message.method === 'Target.setDiscoverTargets') {
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: message.id, result: {} }) }));
    }
  }
  close() {
    this.readyState = SmokeWebSocket.CLOSED;
    queueMicrotask(() => this.emit('close'));
  }
  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

globalThis.WebSocket = SmokeWebSocket;
let createCalls = 0;
globalThis.fetch = async (_url, init) => {
  createCalls += 1;
  equal(init?.method, 'POST');
  equal(new Headers(init?.headers).get('X-BB-API-Key'), 'package-smoke-key');
  return Response.json({
    id: 'package-smoke-session',
    projectId: 'package-smoke-project',
    status: 'RUNNING',
    connectUrl: 'ws://package-smoke.invalid',
  });
};

const browser = await Browser.connect({ provider: 'browserbase' });
equal(browser instanceof Browser, true);
equal(createCalls, 1);
await browser.disconnect();
`,
  {
    BROWSERBASE_API_KEY: 'package-smoke-key',
    BROWSERBASE_PROJECT_ID: 'package-smoke-project',
  }
);

runBundledConsumer(
  'core-after-root',
  `
import { Browser as RootBrowser, CapabilityError as RootCapabilityError } from 'browser-pilot';
import { Browser as CoreBrowser, CapabilityError as CoreCapabilityError } from 'browser-pilot/core';

const equal = (actual, expected, message) => {
  if (actual !== expected) throw new Error(message ?? 'assertion failed');
};
equal(RootCapabilityError, CoreCapabilityError);
equal(RootBrowser === CoreBrowser, false);
try {
  await CoreBrowser.connect({ provider: 'generic' });
  throw new Error('core Browser.connect should require explicit local discovery');
} catch (error) {
  equal(error instanceof RootCapabilityError, true);
  equal(error.capability, 'local-discovery');
}
`,
  { BROWSERBASE_API_KEY: '', BROWSERBASE_PROJECT_ID: '' }
);

console.log(
  'package library smoke passed: ESM/CJS subpaths share identities, root Browser fallback survives bundling, and core stays portable'
);
