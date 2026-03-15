import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAutoConnectHarness, createTestHarness, destroyHarness } from '../utils/harness';
import { generateSessionName, runCLI } from './setup';

describe('CLI connect auto-discovery', () => {
  test('plain bp connect auto-discovers a local browser from DevToolsActivePort', async () => {
    const harness = await createAutoConnectHarness('beta');
    const sessionName = generateSessionName();

    try {
      const result = await runCLI(['connect', '--name', sessionName, '--json', '--no-daemon'], {
        env: harness.discoveryEnv,
      });

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        success: true,
        sessionId: sessionName,
        connectionSource: 'devtools-active-port',
        resolvedChannel: 'beta',
        resolvedUserDataDir: harness.userDataDir,
      });
    } finally {
      await runCLI(['close', '-s', sessionName], { env: harness.discoveryEnv }).catch(() => {});
      await destroyHarness(harness);
    }
  }, 60000);

  test('bp connect --channel narrows local discovery', async () => {
    const harness = await createAutoConnectHarness('beta');
    const sessionName = generateSessionName();

    try {
      const result = await runCLI(
        ['connect', '--name', sessionName, '--channel', 'beta', '--json', '--no-daemon'],
        { env: harness.discoveryEnv }
      );

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        success: true,
        sessionId: sessionName,
        connectionSource: 'devtools-active-port',
        resolvedChannel: 'beta',
      });
    } finally {
      await runCLI(['close', '-s', sessionName], { env: harness.discoveryEnv }).catch(() => {});
      await destroyHarness(harness);
    }
  }, 60000);

  test('bp connect --user-data-dir attaches via an explicit profile path', async () => {
    const harness = await createAutoConnectHarness('beta');
    const sessionName = generateSessionName();

    try {
      const result = await runCLI(
        [
          'connect',
          '--name',
          sessionName,
          '--user-data-dir',
          harness.userDataDir!,
          '--json',
          '--no-daemon',
        ],
        { env: harness.discoveryEnv }
      );

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        success: true,
        sessionId: sessionName,
        connectionSource: 'devtools-active-port',
        resolvedChannel: 'custom',
        resolvedUserDataDir: harness.userDataDir,
      });
    } finally {
      await runCLI(['close', '-s', sessionName], { env: harness.discoveryEnv }).catch(() => {});
      await destroyHarness(harness);
    }
  }, 60000);

  test('plain bp connect still falls back to localhost:9222 /json/version when local discovery is empty', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'browser-pilot-legacy-fallback-'));
    const env = {
      HOME: homeDir,
      USERPROFILE: homeDir,
      LOCALAPPDATA: join(homeDir, 'AppData', 'Local'),
      XDG_CONFIG_HOME: join(homeDir, '.config'),
      CHROME_CONFIG_HOME: join(homeDir, '.config'),
    };
    const legacyProfileDir = join(homeDir, 'legacy-profile');
    await mkdir(legacyProfileDir, { recursive: true });
    const legacyHarness = await createTestHarness({
      userDataDir: legacyProfileDir,
      discoveryEnv: env,
      cleanupPaths: [homeDir],
    });
    const info = (await fetch(`http://localhost:${legacyHarness.chrome.port}/json/version`).then(
      (response) => response.json()
    )) as { webSocketDebuggerUrl: string };
    const legacyStub = Bun.serve({
      port: 9222,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/json/version') {
          return Response.json({
            webSocketDebuggerUrl: info.webSocketDebuggerUrl,
          });
        }
        return new Response('Not Found', { status: 404 });
      },
    });
    const sessionName = generateSessionName();

    try {
      const result = await runCLI(['connect', '--name', sessionName, '--json', '--no-daemon'], {
        env,
      });

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        success: true,
        sessionId: sessionName,
        connectionSource: 'json-version',
      });
    } finally {
      await runCLI(['close', '-s', sessionName], { env }).catch(() => {});
      legacyStub.stop();
      await destroyHarness(legacyHarness);
    }
  }, 60000);
});
