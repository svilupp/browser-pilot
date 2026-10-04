import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { launch } from 'chrome-launcher';
import { Browser } from '../../src/browser/browser.ts';
import { stopDaemon } from '../../src/daemon/lifecycle.ts';

for (const mode of ['direct', 'daemon'] as const) {
  test(`exact observation and supervised portable recordings (${mode})`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'bp-record-supervision-'));
    const chrome = await launch({
      chromeFlags: ['--headless=new', '--disable-gpu', '--no-sandbox'],
    });
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response('<input id="draft"><button id="button">Fixture</button>', {
          headers: { 'content-type': 'text/html' },
        }),
    });
    const bun = process.execPath;
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${dirname(bun)}:${process.env['PATH']}`,
      BROWSER_PILOT_NO_DAEMON: mode === 'direct' ? '1' : '0',
    };
    const entry = resolve(process.env['BROWSER_PILOT_TEST_CLI_ENTRY'] ?? 'src/cli/index.ts');
    async function execute(argv: string[], runtime = bun) {
      const child = Bun.spawn([runtime, ...argv], { env, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      return JSON.parse(stdout);
    }
    const cli = (args: string[]) => execute([entry, ...args, '--json']);
    let browser: Browser | undefined;
    try {
      const version = (await (
        await fetch(`http://localhost:${chrome.port}/json/version`)
      ).json()) as { webSocketDebuggerUrl: string };
      browser = await Browser.connect({ provider: 'generic', wsUrl: version.webSocketDebuggerUrl });
      const first = await browser.newPage();
      const second = await browser.newPage();
      await first.goto(`http://localhost:${server.port}/same`);
      await second.goto(`http://localhost:${server.port}/same`);
      await second.evaluate(() => {
        document.querySelector<HTMLInputElement>('#draft')!.value = 'unsaved private draft';
        document.querySelector<HTMLInputElement>('#draft')!.focus();
      });
      await second.cdpClient.send('Emulation.setDeviceMetricsOverride', {
        width: 320,
        height: 480,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cli([
        'connect',
        '--provider',
        'generic',
        '--url',
        version.webSocketDebuggerUrl,
        '--name',
        'review',
      ]);
      await cli(['use-target', first.targetId!, '-s', 'review']);
      const file = join(home, '.browser-pilot', 'sessions', 'review.json');
      const owner = JSON.parse(await readFile(file, 'utf8'));
      const initialVisibility = await second.evaluate(() => document.visibilityState);
      owner.metadata = { ...owner.metadata };
      owner.metadata.env = {
        ...owner.metadata.env,
        visibility: initialVisibility === 'hidden' ? 'visible' : 'hidden',
      };
      await writeFile(file, JSON.stringify(owner));
      const borrowed = await execute(
        [
          '-e',
          `import {observeSession} from ${JSON.stringify(resolve(process.env['BROWSER_PILOT_OBSERVER_ENTRY'] ?? 'src/adapters/node/observe-session.ts'))}; const b=await observeSession({session:'review',targetId:${JSON.stringify(second.targetId)}}); console.log(JSON.stringify(await b.page.evaluate(()=>({value:document.querySelector('#draft').value,width:innerWidth,visible:document.visibilityState})))); await b.disconnect();`,
        ],
        process.env['BROWSER_PILOT_OBSERVER_RUNTIME'] ?? bun
      );
      expect(borrowed).toMatchObject({
        value: 'unsaved private draft',
        width: 320,
        visible: initialVisibility,
      });
      const after = JSON.parse(await readFile(file, 'utf8'));
      expect(after).toEqual(owner);
      // Old target disappearing must not prevent explicit selection of an existing duplicate URL.
      await first.close();
      const switched = await cli(['use-target', second.targetId!, '-s', 'review']);
      expect(switched.targetId).toBe(second.targetId);
      expect(switched.currentUrl).toBe(`http://localhost:${server.port}/same`);
      // Remove persisted artificial settings; capture --observe must preserve the narrow viewport.
      const updated = JSON.parse(await readFile(file, 'utf8'));
      updated.metadata.env = {};
      await writeFile(file, JSON.stringify(updated));
      await cli([
        'connect',
        '--provider',
        'generic',
        '--url',
        version.webSocketDebuggerUrl,
        '--name',
        'peer',
        '--new-tab',
      ]);
      const peerFile = join(home, '.browser-pilot', 'sessions', 'peer.json');
      const peerInitial = JSON.parse(await readFile(peerFile, 'utf8'));
      await cli(['use-target', second.targetId!, '-s', 'peer']);
      const peerBound = JSON.parse(await readFile(peerFile, 'utf8'));
      if (mode === 'daemon') expect(peerBound.daemon.pid).toBe(updated.daemon.pid);
      await cli(['use-target', peerInitial.targetId, '-s', 'review']);
      expect(
        JSON.stringify(await cli(['eval', 'document.querySelector("#draft").value', '-s', 'peer']))
      ).toContain('unsaved private draft');
      await cli(['use-target', second.targetId!, '-s', 'review']);
      expect(JSON.parse(await readFile(peerFile, 'utf8')).targetId).toBe(second.targetId);
      const artifact = join(home, 'out', 'demo.json');
      const ready = await cli([
        'record',
        '-s',
        'review',
        '--background',
        '--observe',
        '--segment',
        'new',
        '--screenshots',
        'markers',
        '--timeout',
        '20000',
        '-f',
        artifact,
      ]);
      expect(ready.status).toBe('ready');
      expect((await cli(['record', 'status', '-s', 'review'])).recordingId).toBe(ready.recordingId);
      const marker = await cli(['record', 'marker', '-s', 'review', '--label', 'owned checkpoint']);
      await second.evaluate(() => document.querySelector<HTMLButtonElement>('#button')!.click());
      // Marker acknowledgement is asynchronous; wait for its actual sequence before stopping.
      let status = await cli(['record', 'status', '-s', 'review']);
      const deadline = Date.now() + 5000;
      do {
        status = await cli(['record', 'status', '-s', 'review']);
        if (status.markers?.some((m: { id: string }) => m.id === marker.markerId)) break;
        await Bun.sleep(50);
      } while (Date.now() < deadline);
      expect(status.markers).toHaveLength(1);
      const stopped = await cli(['record', 'stop', '-s', 'review']);
      expect(stopped.status).toBe('complete');
      expect(stopped.stopReason).toBe('requested');
      const recorded = JSON.parse(await readFile(artifact, 'utf8'));
      expect(recorded.recording.complete).toBe(true);
      expect(recorded.screenshots).toHaveLength(1);
      expect(recorded.recipe.steps.some((s: { action: string }) => s.action === 'click')).toBe(
        true
      );
      const output = await cli(['record', 'bundle', artifact, '-o', join(home, 'bundle')]);
      expect(output.images).toBe(1);
      await rename(join(home, 'bundle'), join(home, 'moved'));
      await rm(join(home, 'out'), { recursive: true, force: true });
      await cli(['record', 'inspect', join(home, 'moved', 'recording.json')]);
      const derived = await cli([
        'record',
        'derive',
        join(home, 'moved', 'recording.json'),
        '-o',
        join(home, 'workflow.json'),
      ]);
      expect(derived.readiness.safeToReplay).toBe(false);
      await cli([
        'record',
        'export',
        join(home, 'moved', 'recording.json'),
        '-o',
        join(home, 'inline.json'),
      ]);
      expect(
        Object.keys(JSON.parse(await readFile(join(home, 'inline.json'), 'utf8')).images)
      ).toHaveLength(1);
      const secondReady = await cli([
        'record',
        '-s',
        'review',
        '--background',
        '--observe',
        '--segment',
        'append',
        '--privacy',
        'metadata',
        '--timeout',
        '20000',
        '-f',
        join(home, 'second.json'),
      ]);
      expect(secondReady.recordingId).not.toBe(ready.recordingId);
      await second.evaluate(() => {
        const field = document.querySelector<HTMLInputElement>('#draft')!;
        field.value = 'must not leak';
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await Bun.sleep(150);
      await cli(['record', 'stop', '-s', 'review']);
      const segment = await readFile(secondReady.segmentPath, 'utf8');
      expect(segment).not.toContain('must not leak');
      expect(JSON.parse(segment).screenshots).toHaveLength(0);
      expect(
        JSON.parse(await readFile(join(home, 'second.json'), 'utf8')).recipe.steps.length
      ).toBeGreaterThan(recorded.recipe.steps.length);
      expect(await second.evaluate(() => innerWidth)).toBe(320);
    } finally {
      const saved = await readFile(join(home, '.browser-pilot', 'sessions', 'review.json'), 'utf8')
        .then(JSON.parse)
        .catch(() => null);
      if (saved?.daemon?.pid) await stopDaemon(saved.daemon.pid);
      await browser?.disconnect();
      await chrome.kill();
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  }, 60000);
}
