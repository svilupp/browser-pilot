import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const mode of ['all', 'age', 'size', 'dry-run', 'missing-key', 'daemon', 'shared'] as const) {
  test(`CLI cloud cleanup: ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bp-provider-cleanup-'));
    // Run real CLI/provider/session code against isolated files and fake HTTP.
    const script = `
      import assert from 'node:assert/strict';
      import { mock } from 'bun:test';
      const os = await import('node:os');
      mock.module('node:os', () => ({ ...os, homedir: () => ${JSON.stringify(directory)} }));
      const lifecycle = await import('./src/daemon/lifecycle.ts');
      let stops = 0;
      mock.module('./src/daemon/lifecycle.ts', () => ({ ...lifecycle, stopDaemon: async () => { stops++; return true; } }));
      mock.module('./src/daemon/control.ts', () => ({ daemonControlMatches: async () => true }));
      const { cleanCommand } = await import('./src/cli/commands/clean.ts');
      const { createSession, sessionExists } = await import('./src/cli/session.ts');
      const { writeDaemonDescriptor, readDaemonDescriptor } = await import('./src/daemon/registry.ts');
      const mode = ${JSON.stringify(mode)};
      const hasDaemon = mode === 'daemon' || mode === 'shared';
      const remote = { id: 'cloud', provider: 'browserbase', providerSessionId: 'remote',
        wsUrl: 'wss://fixture.invalid/session', metadata: { projectId: 'project', padding: mode === 'size' ? 'x'.repeat(2048) : '' }, currentUrl: 'about:blank',
        createdAt: new Date(0).toISOString(), lastActivity: new Date(0).toISOString(),
        transport: hasDaemon ? { mode: 'daemon', daemonId: 'scripted-daemon' } : { mode: 'direct', reason: 'flag' },
        ...(hasDaemon ? { daemon: { pid: process.pid, socketPath: ${JSON.stringify(join(directory, '.browser-pilot/sessions/cloud/daemon.sock'))}, startedAt: new Date().toISOString() } } : {}),
      };
      await createSession(remote);
      if (hasDaemon) await writeDaemonDescriptor({ schemaVersion: 1, id: 'scripted-daemon', connectionKey: 'scripted-key', endpointFingerprint: 'scripted-fingerprint', ...remote.daemon });
      if (mode === 'shared') await createSession({ ...remote, id: 'shared', lastActivity: new Date(1).toISOString() });
      if (mode === 'size') await createSession({ ...remote, id: 'newest', provider: 'generic', providerSessionId: undefined, metadata: {}, lastActivity: new Date().toISOString() });
      let fail = true, requests = 0;
      globalThis.fetch = async (url, init) => {
        assert.ok(url.endsWith('/v1/sessions/remote'));
        requests++;
        if (fail) return new Response('unavailable', { status: 503 });
        if (init.method === 'POST') assert.deepEqual(JSON.parse(init.body), { projectId: 'project', status: 'REQUEST_RELEASE' });
        return Response.json({ id: 'remote', projectId: 'project', status: 'COMPLETED' });
      };
      const args = mode === 'age' ? ['--max-age', '1'] : mode === 'size' ? ['--max-size', '1KB'] : ['--all'];
      if (mode === 'dry-run') args.push('--dry-run');
      async function clean() {
        let text = '';
        const write = process.stdout.write;
        process.stdout.write = (chunk) => { text += chunk; return true; };
        try { await cleanCommand(args, { format: 'json' }); } finally { process.stdout.write = write; }
        return JSON.parse(text);
      }
      if (mode === 'missing-key') process.env.BROWSERBASE_API_KEY = '';
      const first = await clean();
      assert.equal(await sessionExists('cloud'), true);
      assert.equal(stops, 0);
      if (mode === 'dry-run') {
        assert.equal(requests, 0);
        assert.equal(first.dryRun, true);
        assert.ok(!process.exitCode);
      } else {
        assert.equal(process.exitCode, 1);
        process.exitCode = 0;
        assert.equal(first.cleaned, mode === 'shared' ? 1 : 0);
        assert.equal(first.retained[0].sessionId, 'cloud');
        if (mode === 'missing-key') {
          assert.equal(requests, 0);
          assert.match(first.retained[0].error, /BROWSERBASE_API_KEY/);
          process.env.BROWSERBASE_API_KEY = 'synthetic-key';
        } else {
          assert.equal(requests, 1);
          assert.equal(first.retained[0].providerRelease.status, 'cleanup_pending');
        }
        if (mode === 'size') assert.equal(first.withinLimit, false);
        if (hasDaemon) assert.ok(await readDaemonDescriptor('scripted-daemon'));
        fail = false;
        const retried = await clean();
        assert.equal(retried.cleaned, 1);
        assert.equal(retried.retained, undefined);
        assert.equal(await sessionExists('cloud'), false);
        assert.ok(!process.exitCode);
        if (hasDaemon) { assert.equal(stops, 1); assert.equal(await readDaemonDescriptor('scripted-daemon'), null); }
      }
    `;
    try {
      const proc = Bun.spawn([process.execPath, '--eval', script], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          BROWSERBASE_API_KEY: 'synthetic-key',
          BROWSERBASE_PROJECT_ID: 'project',
        },
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
