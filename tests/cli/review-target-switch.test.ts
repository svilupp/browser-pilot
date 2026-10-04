import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { launch } from 'chrome-launcher';
import { stopDaemon } from '../../src/daemon/lifecycle.ts';

const daemonDisabled = ['1', 'true'].includes(
  String(process.env['BROWSER_PILOT_NO_DAEMON'] ?? '').toLowerCase()
);

test.skipIf(daemonDisabled)(
  'use-target repairs a stale daemon attachment across CLI processes',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'bp-review-switch-'));
    const chrome = await launch({
      chromeFlags: ['--headless=new', '--disable-gpu', '--no-sandbox'],
    });
    const bun = process.execPath;
    const env = { ...process.env, HOME: home, PATH: `${dirname(bun)}:${process.env['PATH']}` };
    async function cli(args: string[]) {
      const entry = process.env['BROWSER_PILOT_TEST_CLI_ENTRY'] ?? 'src/cli/index.ts';
      const child = Bun.spawn([bun, resolve(entry), ...args, '--json'], {
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      return stdout;
    }
    try {
      const version = (await (
        await fetch(`http://localhost:${chrome.port}/json/version`)
      ).json()) as { webSocketDebuggerUrl: string };
      const targets = (await (
        await fetch(`http://localhost:${chrome.port}/json/list`)
      ).json()) as Array<{ id: string; type: string }>;
      const blank = targets.find((target) => target.type === 'page')!.id;
      await cli([
        'connect',
        '--provider',
        'generic',
        '--url',
        version.webSocketDebuggerUrl,
        '--name',
        'switch',
        '--new-tab',
      ]);
      await cli(['use-target', blank, '-s', 'switch']);
      for (let i = 0; i < 2; i++) {
        const output = await cli(['eval', 'document.URL', '-s', 'switch']);
        expect(output).toContain('about:blank');
        await cli(['text', '-s', 'switch']);
      }
      const sessionPath = join(home, '.browser-pilot', 'sessions', 'switch.json');
      const session = JSON.parse(await readFile(sessionPath, 'utf8'));
      session.daemon.cdpSessionId = 'review-stale-flat-session';
      await writeFile(sessionPath, JSON.stringify(session));
      expect(await cli(['eval', 'document.URL', '-s', 'switch'])).toContain('about:blank');
      const repaired = JSON.parse(await readFile(sessionPath, 'utf8'));
      expect(repaired.targetId).toBe(blank);
      expect(repaired.daemon.pid).toBe(session.daemon.pid);
      expect(repaired.daemon.cdpSessionId).not.toBe('review-stale-flat-session');
      expect(await cli(['eval', 'document.URL', '-s', 'switch'])).toContain('about:blank');
    } finally {
      const saved = await readFile(join(home, '.browser-pilot', 'sessions', 'switch.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => undefined);
      if (saved?.daemon?.pid) await stopDaemon(saved.daemon.pid);
      await chrome.kill();
      await rm(home, { recursive: true, force: true });
    }
  },
  30000
);
