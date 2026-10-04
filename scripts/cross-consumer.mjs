// Local real-browser semantics. Requires built browser-pilot and sibling Flightplan.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bash } from 'just-bash';
import {
  acquireDriverLease,
  BrowserPilotDriver,
  memoryFileSystem,
  resolveConfigWithDefaults,
  runFlow,
} from '../../flightplan/dist/worker.js';
import { MemoryArtifactSink } from '../dist/adapters/memory/index.mjs';
import { ConnectionSessionOwner, connect } from '../dist/index.mjs';
import { commandsForJustBash } from '../dist/just-bash/index.mjs';

const [wsUrl, parentOrigin, childOrigin] = process.argv.slice(2);
assert(wsUrl && parentOrigin && childOrigin, 'requires local CDP and two fixture origins');
const directory = await mkdtemp(join(tmpdir(), 'bp-cross-consumer-'));
const url = new URL('/cloudflare-conformance.html', parentOrigin);
url.searchParams.set('childOrigin', childOrigin);
const verifyChild =
  '(() => { if (document.querySelector("#identity").textContent !== "Child fixture v1") throw new Error("wrong child"); return true; })()';
const verifyParent =
  '(() => { if (document.querySelector("#value").value !== "parent-only" || document.querySelector("#child-result").textContent !== "child-only" || document.querySelector("#count").textContent !== "1" || document.querySelector("#spa-ready").textContent !== "Next content v1") throw new Error("journey mismatch"); return true; })()';
const steps = [
  { action: 'goto', url: url.href },
  { action: 'fill', selector: '#value', value: 'parent-only' },
  { action: 'click', selector: '#click' },
  { action: 'click', selector: '#route' },
  { action: 'wait', selector: '#spa-ready' },
  { action: 'switchFrame', selector: '#child' },
  { action: 'evaluate', value: verifyChild, effect: 'observe' },
  { action: 'fill', selector: '#value', value: 'child-only' },
  { action: 'switchToMain' },
  { action: 'wait', selector: '#child-result' },
  { action: 'evaluate', value: verifyParent, effect: 'observe' },
];
const png = (bytes) =>
  assert.equal(Buffer.from(bytes).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
const quote = (text) => `'${text.replaceAll("'", "'\"'\"'")}'`;
async function cli(args) {
  const child = spawn('bun', ['dist/cli.mjs', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.on('exit', resolve);
    child.on('error', reject);
  });
  assert.equal(code, 0, stderr);
  return stdout;
}
let browser, owner, handle;
const session = `cross-consumer-${Date.now()}`;
const ctx = {
  generation: 'fixture',
  signal: new AbortController().signal,
  clock: { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
};
try {
  browser = await connect({ provider: 'generic', wsUrl });
  const page = await browser.page();
  assert.equal((await page.batch(steps)).success, true, 'direct journey');
  png(Buffer.from(await page.screenshot(), 'base64'));
  await browser.disconnect();
  browser = undefined;

  await cli(['connect', '--provider', 'generic', '--url', wsUrl, '--name', session, '--json']);
  const cliResult = JSON.parse(await cli(['exec', '-s', session, '--json', JSON.stringify(steps)]));
  assert.equal(cliResult.success, true, JSON.stringify(cliResult));
  const cliPng = join(directory, 'cli.png');
  await cli(['screenshot', '-s', session, '-o', cliPng]);
  png(await readFile(cliPng));
  await cli(['close', '-s', session]);

  let ownerConnections = 0;
  owner = new ConnectionSessionOwner({
    connect: (options) => {
      ownerConnections++;
      return connect(options);
    },
  });
  handle = await owner.open({ provider: 'generic', wsUrl }, ctx);
  const artifacts = MemoryArtifactSink();
  const bash = new Bash({
    customCommands: commandsForJustBash({
      sessionOwner: owner,
      artifacts,
      clock: ctx.clock,
      createContext: () => ctx,
      capabilities: { read: true, action: true, evaluate: true, webmcp: false },
    }),
  });
  for (let i = 0; i < 2; i++) {
    const result = await bash.exec(
      `bp run ${quote(JSON.stringify(handle))} ${quote(JSON.stringify(steps))}`
    );
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    const screenshot = await bash.exec(
      `bp screenshot ${quote(JSON.stringify(handle))} --out shell-${i}.png`
    );
    assert.equal(screenshot.exitCode, 0, screenshot.stderr);
    png(artifacts.store.get(`shell-${i}.png`).bytes);
  }

  const config = resolveConfigWithDefaults([
    {
      connect: { mode: 'session', session_ref: 'fixture', target_policy: 'selected' },
      browser: { record: true },
      timeouts: { nav_ms: 1000 },
    },
  ]);
  const fs = memoryFileSystem();
  const flowImages = new Map();
  const writeBinary = fs.writeBinaryFile.bind(fs);
  fs.writeBinaryFile = async (path, bytes) => {
    flowImages.set(path, bytes);
    await writeBinary(path, bytes);
  };
  const tomlValue = (value) =>
    Array.isArray(value)
      ? `[${value.map(tomlValue).join(',')}]`
      : value && typeof value === 'object'
        ? `{${Object.entries(value)
            .map(([key, item]) => `${key}=${tomlValue(item)}`)
            .join(',')}}`
        : JSON.stringify(value);
  const flowSteps = steps
    .map((step, i) => {
      const converted = { id: `step-${i}`, do: step.action };
      if (step.action === 'goto') converted.url = step.url;
      if (['fill', 'click', 'wait', 'switchFrame'].includes(step.action))
        converted.target = `css:${step.selector}`;
      if (step.action === 'fill') converted.value = step.value;
      if (step.action === 'wait') {
        converted.do = 'assert';
        converted.target = undefined;
        converted.assert = [{ type: 'visible', selector: step.selector }];
      }
      if (step.action === 'switchFrame') converted.do = 'switch_frame';
      if (step.action === 'switchToMain') converted.do = 'switch_to_main';
      if (step.action === 'evaluate') {
        converted.expression = step.value;
        converted.effect = 'observe';
      }
      return (
        '\n[[steps]]\n' +
        Object.entries(converted)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}=${tomlValue(value)}`)
          .join('\n')
      );
    })
    .join('\n');
  for (let i = 0; i < 2; i++) {
    const run = await runFlow({
      flowPath: '/fixture/flow.toml',
      flowSource: `version=1\nkind="flow"\nid="fixture"\ndescription="Shared journey"\n${flowSteps}`,
      config,
      fs,
      env: {},
      out: '/fixture/runs',
      runId: `borrow-${i}`,
      timeoutMs: 30000,
      driverFactory: (_cfg, scope) =>
        new BrowserPilotDriver({
          acquisitionContext: scope,
          acquire: async () => acquireDriverLease(await owner.acquire(handle, ctx)),
        }),
    });
    assert.equal(run.summary.verdict, 'passed', JSON.stringify(run.summary));
    assert(run.summary.screenshot_paths.length > 0, 'Flightplan PNG artifacts');
    png(flowImages.get(run.summary.screenshot_paths.at(-1)));
  }
  assert.equal(ownerConnections, 1, 'shell and Flightplan must reuse one owner connection');
  const inspection = await owner.inspect(handle, ctx);
  assert.equal(inspection.documentHealthy, true, 'borrowers preserve renderer');
  console.log(
    JSON.stringify({
      status: 'pass',
      runtime: process.version,
      provider: 'local Chromium',
      fixture: 'v1',
      consumers: ['direct', 'built CLI', 'just-bash', 'Flightplan'],
      borrowedShellRuns: 2,
      borrowedFlowRuns: 2,
      ownerConnections,
      screenshots: 'valid PNG',
      payment: 'not attempted',
    })
  );
} finally {
  await browser?.disconnect();
  if (handle) await owner.release(handle, ctx);
  await cli(['close', '-s', session]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
