import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('BrowserBase CLI args', () => {
  test('help text mentions BROWSERBASE_API_KEY env fallback', async () => {
    const content = await Bun.file('src/cli/commands/connect.ts').text();
    expect(content).toContain('BROWSERBASE_API_KEY');
  });

  test('help text mentions BROWSERBASE_PROJECT_ID env fallback and optionality', async () => {
    const content = await Bun.file('src/cli/commands/connect.ts').text();
    expect(content).toContain('BROWSERBASE_PROJECT_ID');
    expect(content).toMatch(/project-id[^\n]*\(optional/i);
  });

  test('provider validation accepts browserbase', async () => {
    const content = await Bun.file('src/cli/commands/connect.ts').text();
    expect(content).toContain("'browserbase'");
  });

  test('does not hard-require --project-id for browserbase at the CLI level', async () => {
    const content = await Bun.file('src/cli/commands/connect.ts').text();
    // There must be no validation that throws specifically because projectId
    // is missing while provider === 'browserbase'.
    expect(content).not.toMatch(/project-id[^\n]{0,80}(required|must be provided|is required)/i);
    expect(content).not.toMatch(/browserbase[^\n]{0,120}requires[^\n]{0,40}project/i);
  });

  test('--env-file global flag is documented in the root CLI help', async () => {
    const content = await Bun.file('src/cli/index.ts').text();
    expect(content).toContain('--env-file');
    expect(content).toContain('BROWSER_PILOT_NO_DOTENV');
  });
});

describe('CLI provider lifecycle', () => {
  for (const scenario of [
    'commands',
    'setup-failed',
    'setup-pending',
    'daemon-failed',
    'browserless',
  ] as const) {
    test(scenario, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'bp-provider-lifecycle-'));
      // Isolate module patches and session files from the unit runner and the user's sessions.
      const script = `
        import assert from 'node:assert/strict';
        import { mock } from 'bun:test';
        const os = await import('node:os');
        mock.module('node:os', () => ({ ...os, homedir: () => ${JSON.stringify(directory)} }));
        const scenario = ${JSON.stringify(scenario)};
        mock.module('./src/cli/daemon-spawn.ts', () => ({
          spawnDaemon: () => { throw new Error('scripted daemon failure'); },
          waitForDaemonReady: async () => false,
        }));
        const { Browser } = await import('./src/browser/connect.ts');
        const { createProvider } = await import('./src/providers/index.ts');
        const { connectCommand } = await import('./src/cli/commands/connect.ts');
        const { closeCommand } = await import('./src/cli/commands/close.ts');
        const { textCommand } = await import('./src/cli/commands/text.ts');
        const { sessionExists, loadSession } = await import('./src/cli/session.ts');
        let creates = 0, releases = 0, disconnects = 0;
        let keepAlive = false, alive = false, failRelease = scenario === 'setup-pending';
        let currentUrl = 'https://fixture.test/preserved';
        const remote = { id: 'remote-session', projectId: 'project', connectUrl: 'wss://fixture.invalid/session' };
        globalThis.fetch = async (url, init) => {
          if (url.endsWith('/v1/sessions')) {
            creates++;
            assert.equal(init.method, 'POST');
            keepAlive = JSON.parse(init.body).keepAlive === true;
            alive = true;
            return Response.json({ ...remote, status: 'RUNNING' });
          }
          assert.ok(url.endsWith('/v1/sessions/remote-session'));
          if (init?.method === 'POST') {
            assert.deepEqual(JSON.parse(init.body), { projectId: 'project', status: 'REQUEST_RELEASE' });
            releases++;
            if (failRelease) return new Response('unavailable', { status: 503 });
            alive = false;
          }
          return Response.json({ ...remote, status: alive ? 'RUNNING' : 'COMPLETED' });
        };
        Browser.connect = async (options) => {
          const provider = createProvider(options);
          const session = await provider.createSession(options.session);
          assert.equal(session.wsUrl, remote.connectUrl);
          if (!alive) throw new Error('session ended on disconnect');
          const page = { targetId: 'stable-target', url: async () => currentUrl, text: async () => 'preserved document' };
          const browser = {
            wsUrl: session.wsUrl, sessionId: session.sessionId, metadata: session.metadata,
            page: async (_url, options) => {
              if (scenario.startsWith('setup-')) throw new Error('scripted page failure');
              if (options?.targetId) assert.equal(options.targetId, 'stable-target');
              return page;
            },
            disconnect: async () => { disconnects++; if (!keepAlive) alive = false; },
            close: async () => { await browser.disconnect(); return session.close(); },
          };
          return browser;
        };
        const args = ['--provider', scenario === 'browserless' ? 'browserless' : 'browserbase', '--name', 'test'];
        if (scenario !== 'daemon-failed') args.push('--no-daemon');
        if (scenario === 'browserless') {
          await assert.rejects(connectCommand(args, {}), /cannot reconnect Browserless/);
          assert.equal(creates, 0);
          assert.equal(await sessionExists('test'), false);
        } else if (scenario.startsWith('setup-')) {
          await assert.rejects(connectCommand(args, {}), /scripted page failure|cleanup pending/);
          assert.equal(creates, 1);
          assert.equal(releases, 1);
          assert.equal(await sessionExists('test'), failRelease);
          if (failRelease) {
            assert.equal((await loadSession('test')).providerSessionId, remote.id);
            failRelease = false;
            await closeCommand(['test'], { format: 'json' });
            assert.equal(await sessionExists('test'), false);
          }
          assert.equal(alive, false);
        } else if (scenario === 'daemon-failed') {
          await assert.rejects(connectCommand(args, {}), /session test retained/);
          assert.equal(await sessionExists('test'), true);
          assert.equal(alive, true);
          await closeCommand(['test'], { format: 'json' });
          assert.equal(alive, false);
          assert.equal(await sessionExists('test'), false);
        } else {
          await connectCommand(args, { format: 'json' });
          const stored = await loadSession('test');
          assert.equal(stored.providerSessionId, remote.id);
          assert.equal(keepAlive, true);
          await textCommand([], { session: 'test', format: 'json' });
          await textCommand([], { session: 'test', format: 'json' });
          assert.equal(creates, 1, 'reattach must not create a fresh provider session');
          assert.equal(disconnects, 3);
          assert.equal(alive, true);
          failRelease = true;
          await closeCommand(['test'], { format: 'json' });
          assert.equal(process.exitCode, 1);
          process.exitCode = 0;
          assert.equal(await sessionExists('test'), true);
          failRelease = false;
          await closeCommand(['test'], { format: 'json' });
          assert.equal(await sessionExists('test'), false);
          assert.equal(alive, false);
          assert.equal(releases, 2);
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
            BROWSER_PILOT_NO_DAEMON: '',
            BROWSER_PILOT_NO_DOTENV: '1',
          },
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
        if (scenario === 'commands') expect(stdout).toContain('preserved document');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
