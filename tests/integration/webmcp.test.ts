import { describe, expect, test } from 'bun:test';
import { generateSessionName, runCLI } from '../cli/setup.ts';
import { createAutoConnectHarness, destroyHarness } from '../utils/harness.ts';

describe('WebMCP CLI', () => {
  test('discovers and invokes page tools through one direct session', async () => {
    const harness = await createAutoConnectHarness('beta');
    const session = generateSessionName();
    try {
      const connected = await runCLI(
        [
          'connect',
          '--name',
          session,
          '--new-tab',
          '--page-url',
          `${harness.baseUrl}/webmcp.html`,
          '--no-daemon',
          '--json',
        ],
        { env: harness.discoveryEnv }
      );
      expect(connected.exitCode).toBe(0);

      const ready = await runCLI(
        [
          'eval',
          '-s',
          session,
          '--json',
          'window.__webmcpReady ? window.__webmcpReady.then(() => window.__webmcpNative) : window.__webmcpNative',
        ],
        { env: harness.discoveryEnv }
      );
      expect(ready.exitCode).toBe(0);
      if (process.env['BROWSER_PILOT_NATIVE_WEBMCP'] === '1') {
        expect(ready.json).toMatchObject({ result: true });
      }

      const listed = await runCLI(['webmcp', 'list', '-s', session, '--json'], {
        env: harness.discoveryEnv,
      });
      expect(listed.exitCode).toBe(0);
      expect(listed.json).toMatchObject({
        status: { available: true },
        tools: expect.arrayContaining([expect.objectContaining({ name: 'lookupStatus' })]),
      });

      const called = await runCLI(
        ['webmcp', 'call', 'lookupStatus', '--input', '{}', '-s', session, '--json'],
        { env: harness.discoveryEnv }
      );
      if (called.exitCode !== 0) console.error(called.stderr);
      expect(called.exitCode).toBe(0);
      expect(called.json).toMatchObject({ result: 'ready', tool: { name: 'lookupStatus' } });
    } finally {
      await runCLI(['close', '-s', session], { env: harness.discoveryEnv }).catch(() => {});
      await destroyHarness(harness);
    }
  }, 60000);
});
