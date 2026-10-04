import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const directory = await mkdtemp(join(tmpdir(), 'bp-workerd-'));
let runtime;
try {
  const name = execFileSync(
    'npm',
    ['pack', '--silent', '--ignore-scripts', '--pack-destination', directory],
    { encoding: 'utf8' }
  ).trim();
  execFileSync('tar', ['-xzf', join(directory, name), '-C', directory]);
  await writeFile(
    join(directory, 'types.ts'),
    `import { ConnectionSessionOwner, connectCore } from 'browser-pilot/core'; import { createWorkersTransportFactory, type BrowserBinding } from 'browser-pilot/adapters/workers'; const owner = new ConnectionSessionOwner({connect: options => connectCore({...options, transportFactory: createWorkersTransportFactory()})}); const binding: BrowserBinding | undefined = undefined; void owner; void binding;`
  );
  await writeFile(
    join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        types: [],
        lib: ['ES2022', 'DOM'],
        module: 'ESNext',
        moduleResolution: 'Bundler',
        paths: {
          'browser-pilot/core': [join(directory, 'package/dist/core/index.d.ts')],
          'browser-pilot/adapters/workers': [
            join(directory, 'package/dist/adapters/workers/index.d.ts'),
          ],
        },
      },
      files: ['types.ts'],
    })
  );
  execFileSync(
    join(process.cwd(), 'node_modules/.bin/tsc'),
    ['--project', join(directory, 'tsconfig.json')],
    { stdio: 'inherit' }
  );
  const companion = process.argv.includes('--flightplan');
  const aliases = {};
  if (companion) {
    const companionDir = join(directory, 'flightplan');
    await mkdir(companionDir);
    const archive = execFileSync(
      'npm',
      ['pack', '--silent', '--ignore-scripts', '--pack-destination', companionDir],
      { cwd: '../flightplan', encoding: 'utf8' }
    ).trim();
    execFileSync('tar', ['-xzf', join(companionDir, archive), '-C', companionDir]);
    aliases['@svilupp/flightplan/worker'] = join(companionDir, 'package/dist/worker.js');
    aliases['zod'] = join(process.cwd(), '../flightplan/node_modules/zod/index.js');
  }
  let fixture = await readFile('tests/workers/fixture.mjs', 'utf8');
  if (companion)
    fixture =
      `import { BrowserPilotDriver, acquireDriverLease, runFlow, memoryFileSystem, resolveConfigWithDefaults } from '@svilupp/flightplan/worker';\n` +
      fixture.replace(
        '/* companion runs */',
        `
    const fs = memoryFileSystem();
    const config = resolveConfigWithDefaults([{ connect: { mode: 'session', session_ref: 'fixture', target_policy: 'exact', target_id: 'page' } }]);
    for (let i = 0; i < 2; i++) {
      const run = await runFlow({
        flowPath: '/fixture/flow.toml',
        flowSource: 'version=1\\nkind="flow"\\nid="fixture"\\ndescription="borrowed fixture"\\n[[steps]]\\nid="title"\\ndo="evaluate"\\nexpression="document.title"\\neffect="observe"',
        fs, config, env: {}, out: '/fixture/runs', runId: 'borrow-' + i, timeoutMs: 10000,
        driverFactory: (_cfg, scope) => new BrowserPilotDriver({ acquisitionContext: scope, acquire: async () => acquireDriverLease(await owner.acquire(handle, ctx), 'page') }),
      });
      assert(run.summary.verdict === 'passed', 'companion complete flow ' + JSON.stringify(run.summary));
      const lease = await owner.acquire(handle, ctx);
      assert((await (await lease.browser.page()).screenshot()) === 'iVBORw0KGgo=', 'owner usable after flow teardown');
      await lease.detach();
    }
    assert(opens === before, 'companion borrows must preserve the owner socket');
  `
      );
  const result = await build({
    stdin: {
      contents: fixture,
      resolveDir: directory,
      sourcefile: 'fixture.mjs',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    alias: {
      ...aliases,
      ...Object.fromEntries(
        ['adapters/workers', 'core', 'shell'].map((name) => [
          `browser-pilot/${name}`,
          join(directory, 'package/dist', name, 'index.mjs'),
        ])
      ),
    },
    nodePaths: companion ? [join(process.cwd(), '../flightplan/node_modules')] : [],
    metafile: true,
    logLevel: 'silent',
  });
  for (const file of Object.keys(result.metafile.inputs))
    assert(
      !/node:|adapters\/node|adapters\/bun|\/cli\.|\/daemon\.|\/ws\//.test(file),
      `forbidden Worker dependency: ${file}`
    );
  const script = result.outputFiles[0].text;
  assert(
    !/\bprocess\.|\bglobalThis\.Bun\b|\bBuffer\b/.test(script),
    'forbidden Worker host globals'
  );
  runtime = new Miniflare({
    modules: [{ type: 'ESModule', path: 'worker.mjs', contents: script }],
    compatibilityDate: '2026-07-30',
  });
  const response = await runtime.dispatchFetch('https://fixture.test');
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.status, 'pass');
  console.log(JSON.stringify({ runtime: 'local workerd', ...data }));
} finally {
  await runtime?.dispose();
  await rm(directory, { recursive: true, force: true });
}
