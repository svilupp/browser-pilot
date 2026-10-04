import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stopDaemonForRecovery } from '../../src/daemon/control.ts';

for (const mode of ['loss', 'recovery', 'explicit', 'close-force', 'clean-force'] as const)
  test(`review: Cloudflare Chromium shutdown ${mode} has correct allocation ownership`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'bp-review-daemon-loss-'));
    const marker = join(home, 'provider-released');
    const source = resolve('src/browser/connect.ts');
    const preload = join(home, 'mock-connect.ts');
    await mkdir(join(home, '.browser-pilot', 'sessions'), { recursive: true });
    await writeFile(
      join(home, '.browser-pilot', 'sessions', 'review.json'),
      JSON.stringify({
        id: 'review',
        provider: 'cloudflare',
        wsUrl: 'wss://fixture.invalid',
        providerSessionId: 'allocation-exact',
        bootstrapState: 'ready',
        metadata: { ownership: 'owned', detectedEngine: 'chromium' },
        cloudflareRequest: { provider: 'cloudflare', cloudflare: { accountId: 'fixture' } },
      })
    );
    await writeFile(
      preload,
      `import { mock } from 'bun:test';
import { writeFile } from 'node:fs/promises';
const cdp = { isConnected: true, send: async () => ({}), on() {}, onAny() {}, offAny() {}, onTargetAttached() { return () => {}; }, close: async () => {} };
mock.module(${JSON.stringify(source)}, () => ({ connect: async () => {
  ${mode === 'loss' ? 'setTimeout(() => { cdp.isConnected = false; }, 50);' : ''}
  return { wsUrl: 'wss://fixture.invalid', sessionId: 'allocation-exact', metadata: { ownership: 'owned', detectedEngine: 'chromium' }, cdpClient: cdp,
    close: async () => { await writeFile(${JSON.stringify(marker)}, 'DELETE allocation-exact'); return { status: 'released', sessionId: 'allocation-exact' }; },
    disconnect: async () => {} };
} }));`
    );
    const child = Bun.spawn(
      [process.execPath, '--preload', preload, resolve('src/daemon/index.ts'), 'review'],
      {
        env: { ...process.env, HOME: home },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    try {
      if (mode !== 'loss') {
        let daemon: { socketPath: string; pid: number } | undefined;
        for (let i = 0; i < 100 && !daemon; i++) {
          const saved = JSON.parse(
            await readFile(join(home, '.browser-pilot', 'sessions', 'review.json'), 'utf8')
          );
          daemon = saved.daemon;
          if (!daemon) await Bun.sleep(20);
        }
        expect(daemon).toBeDefined();
        if (mode === 'recovery') await stopDaemonForRecovery({ ...daemon! });
        else if (mode === 'explicit') child.kill('SIGTERM');
        else {
          const command = mode === 'close-force' ? 'close' : 'clean';
          const commandPath = resolve(`src/cli/commands/${command}.ts`);
          const args = mode === 'close-force' ? ['review', '--force'] : ['--all', '--force'];
          const action = Bun.spawn(
            [
              process.execPath,
              '--eval',
              `import { ${command}Command } from ${JSON.stringify(commandPath)}; await ${command}Command(${JSON.stringify(args)}, {format:'json'});`,
            ],
            {
              env: { ...process.env, HOME: home },
              stdout: 'pipe',
              stderr: 'pipe',
            }
          );
          const output = await new Response(action.stdout).text();
          expect(await action.exited).toBe(0);
          expect(output).toContain('Cloudflare session was not released');
        }
      }
      expect(await child.exited).toBe(0);
      const sessionPath = join(home, '.browser-pilot', 'sessions', 'review.json');
      if (mode.endsWith('force')) expect(await Bun.file(sessionPath).exists()).toBe(false);
      else {
        const session = JSON.parse(await readFile(sessionPath, 'utf8'));
        expect(session.providerSessionId).toBe('allocation-exact');
      }
      expect(await Bun.file(marker).exists()).toBe(mode === 'explicit');
    } finally {
      child.kill();
      await rm(home, { recursive: true, force: true });
    }
  }, 10000);
