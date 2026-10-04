import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'bp-node-matrix-'));
try {
  const name = execFileSync(
    'npm',
    ['pack', '--silent', '--ignore-scripts', '--pack-destination', directory],
    { encoding: 'utf8' }
  ).trim();
  await writeFile(join(directory, 'package.json'), '{"private":true,"type":"module"}');
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, name), 'ws@8.18.3'],
    { cwd: directory, stdio: 'pipe' }
  );
  await copyFile('scripts/node-cloudflare-consumer.mjs', join(directory, 'consumer.mjs'));
  for (const version of ['18.20.8', '22.22.0', '24.13.0']) {
    execFileSync('npx', ['--yes', '--package', `node@${version}`, 'node', 'consumer.mjs'], {
      cwd: directory,
      stdio: 'inherit',
    });
  }
  // A separate clean extraction has no peer resolution path.
  const absent = join(directory, 'absent');
  execFileSync('mkdir', ['-p', absent]);
  execFileSync('tar', ['-xzf', join(directory, name), '-C', absent]);
  const code = `import {connect} from './package/dist/index.mjs'; let allocations=0; globalThis.fetch=async()=>{allocations++;throw Error('unexpected')}; try { await connect({provider:'cloudflare',apiKey:'fixture',cloudflare:{accountId:'account'}}); throw Error('missing early failure'); } catch(error) { if(!error.message.includes('npm install browser-pilot ws')||allocations) throw error; }`;
  await writeFile(join(absent, 'test.mjs'), code);
  // Remove the installed peer so it cannot resolve through the parent folder.
  await rm(join(directory, 'node_modules/ws'), { recursive: true });
  execFileSync('node', ['test.mjs'], { cwd: absent, stdio: 'inherit' });
  assert(true);
  console.log('optional peer absent: pass before allocation');
} finally {
  await rm(directory, { recursive: true, force: true });
}
