import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, resolveBrowserEndpoint } from '../../src';
import { generateSessionName, runCLI } from '../cli/setup';
import { createAutoConnectHarness, destroyHarness } from '../utils/harness';

describe('Local discovery integration', () => {
  test('library connect can attach through DevToolsActivePort and interact with a page', async () => {
    const harness = await createAutoConnectHarness('beta');
    try {
      const browser = await connect({
        provider: 'generic',
        userDataDir: harness.userDataDir,
      });
      const page = await browser.newPage(`${harness.baseUrl}/basic.html`);
      expect(await page.url()).toContain('basic.html');
      const title = await page.title();
      expect(title.toLowerCase()).toContain('basic');
      await browser.close();
    } finally {
      await destroyHarness(harness);
    }
  }, 60000);

  test('auto-discovered connect supports session reuse across follow-up CLI commands', async () => {
    const harness = await createAutoConnectHarness('beta');
    const sessionName = generateSessionName();

    try {
      const connectResult = await runCLI(['connect', '--name', sessionName, '--json'], {
        env: harness.discoveryEnv,
      });

      expect(connectResult.exitCode).toBe(0);
      expect(connectResult.json).toMatchObject({
        success: true,
        connectionSource: 'devtools-active-port',
        sessionId: sessionName,
      });

      const execResult = await runCLI(
        [
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify({ action: 'goto', url: `${harness.baseUrl}/form.html` }),
        ],
        { env: harness.discoveryEnv }
      );
      expect(execResult.exitCode).toBe(0);

      const pageResult = await runCLI(['page', '-s', sessionName], { env: harness.discoveryEnv });
      expect(pageResult.exitCode).toBe(0);
      expect(pageResult.stdout).toContain('form.html');
    } finally {
      await runCLI(['close', '-s', sessionName], { env: harness.discoveryEnv }).catch(() => {});
      await destroyHarness(harness);
    }
  }, 60000);

  test('auto-discovered connect still supports fresh-tab creation', async () => {
    const harness = await createAutoConnectHarness('beta');
    const sessionName = generateSessionName();

    try {
      const result = await runCLI(
        [
          'connect',
          '--name',
          sessionName,
          '--new-tab',
          '--page-url',
          `${harness.baseUrl}/basic.html`,
          '--json',
          '--no-daemon',
        ],
        { env: harness.discoveryEnv }
      );

      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({
        success: true,
        connectionSource: 'devtools-active-port',
        currentUrl: expect.stringContaining('basic.html'),
      });
    } finally {
      await runCLI(['close', '-s', sessionName], { env: harness.discoveryEnv }).catch(() => {});
      await destroyHarness(harness);
    }
  }, 60000);

  test('stale DevToolsActivePort files fail deterministically', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'browser-pilot-stale-devtools-'));
    try {
      await mkdir(userDataDir, { recursive: true });
      await writeFile(
        join(userDataDir, 'DevToolsActivePort'),
        '65534\n/devtools/browser/stale-browser\n'
      );

      await expect(
        resolveBrowserEndpoint({
          userDataDir,
          allowLegacyHostFallback: false,
        })
      ).rejects.toMatchObject({
        code: 'browser-not-found',
        details: {
          failures: [{ reason: expect.stringMatching(/connection-|unexpected-close|cdp-error/) }],
        },
      });
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  }, 60000);
});
