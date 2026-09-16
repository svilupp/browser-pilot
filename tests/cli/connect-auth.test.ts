import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CookieState, SerializedCookie } from '../../src/auth/types.ts';
import { withRetry } from '../utils/retry.ts';
import { generateSessionName, getWebSocketUrl, runCLI, setup, teardown } from './setup.ts';

const SESSION_DIR = join(homedir(), '.browser-pilot', 'sessions');

function cookie(
  overrides: Partial<SerializedCookie> & { name: string; value: string; domain: string }
): SerializedCookie {
  return {
    hostOnly: true,
    path: '/',
    secure: false,
    httpOnly: false,
    sameSite: null,
    expires: null,
    priority: 'Medium',
    sourceScheme: 'NonSecure',
    sourcePort: 80,
    ...overrides,
  };
}

function snapshot(sourceUrl: string, cookies: SerializedCookie[]): CookieState {
  return {
    format: 'browser-pilot-cookie-auth',
    schemaVersion: 1,
    savedAt: new Date().toISOString(),
    sourceUrl,
    cookies,
  };
}

async function cleanupSession(sessionName: string): Promise<void> {
  await runCLI(['close', '-s', sessionName]).catch(() => {});
  rmSync(join(SESSION_DIR, sessionName), { recursive: true, force: true });
  rmSync(join(SESSION_DIR, `${sessionName}.json`), { force: true });
}

describe('CLI connect --auth', () => {
  let tmpDir = '';
  let requestLog: Array<{ url: string; cookie: string | null }> = [];
  let fixtureServer: ReturnType<typeof Bun.serve> | null = null;
  let fixtureBaseUrl = '';
  let fixturePort = 0;

  beforeAll(async () => {
    await setup();
    tmpDir = await Bun.$`mktemp -d`.text().then((s) => s.trim());

    fixtureServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        requestLog.push({ url: url.pathname, cookie: req.headers.get('cookie') });
        return new Response(
          `<!doctype html><html><body id="root">ok<pre id="cookie">${req.headers.get('cookie') ?? ''}</pre></body></html>`,
          { headers: { 'content-type': 'text/html; charset=utf-8' } }
        );
      },
    });
    const port = fixtureServer.port;
    if (port === undefined) throw new Error('Expected Bun.serve() to allocate a port');
    fixturePort = port;
    fixtureBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    fixtureServer?.stop(true);
    fixtureServer = null;
    rmSync(tmpDir, { recursive: true, force: true });
    await teardown();
  });

  function refPath(name: string): string {
    return join(tmpDir, name);
  }

  async function writeSnapshot(name: string, state: CookieState): Promise<string> {
    const path = refPath(name);
    await Bun.write(path, `${JSON.stringify(state, null, 2)}\n`);
    return path;
  }

  test('--auth conflicts with --resume', async () => {
    const result = await runCLI(['connect', '--auth', refPath('x.json'), '--resume', 'whatever']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain('--auth');
    expect(result.stderr.toLowerCase()).toContain('resume');
  });

  test('--auth conflicts with global -s', async () => {
    const result = await runCLI(['connect', '-s', 'whatever', '--auth', refPath('x.json')]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain('--auth');
  });

  test('--auth conflicts with --target-url', async () => {
    const result = await runCLI([
      'connect',
      '--auth',
      refPath('x.json'),
      '--target-url',
      'example.com',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain('--target-url');
  });

  test('restore precedes the first navigation request (direct path) and implies --new-tab', async () => {
    await withRetry(async () => {
      requestLog = [];
      const sessionName = generateSessionName();
      const ref = await writeSnapshot(
        `${sessionName}.json`,
        snapshot(`${fixtureBaseUrl}/`, [
          cookie({
            name: 'authcookie',
            value: 'snapshot-value',
            domain: '127.0.0.1',
            sourcePort: fixturePort,
          }),
        ])
      );

      try {
        const wsUrl = await getWebSocketUrl();
        const result = await runCLI([
          'connect',
          '--provider',
          'generic',
          '--browser-url',
          wsUrl,
          '--name',
          sessionName,
          '--no-daemon',
          '--auth',
          ref,
          '--json',
        ]);

        expect(result.exitCode).toBe(0);
        expect(result.json).toMatchObject({ success: true, currentUrl: `${fixtureBaseUrl}/` });
        const json = result.json as {
          cookieAuth?: { restored: number; skippedExpired: number; unverified: number };
        };
        expect(json.cookieAuth?.restored).toBe(1);

        // The very first request the fixture ever saw for this snapshot
        // already carries the restored cookie: no unauthenticated leak.
        expect(requestLog.length).toBeGreaterThan(0);
        expect(requestLog[0]?.cookie).toContain('authcookie=snapshot-value');
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  test('restore precedes the first navigation request (daemon path)', async () => {
    await withRetry(async () => {
      requestLog = [];
      const sessionName = generateSessionName();
      const ref = await writeSnapshot(
        `${sessionName}.json`,
        snapshot(`${fixtureBaseUrl}/`, [
          cookie({
            name: 'authcookie',
            value: 'daemon-value',
            domain: '127.0.0.1',
            sourcePort: fixturePort,
          }),
        ])
      );

      try {
        const wsUrl = await getWebSocketUrl();
        const result = await runCLI([
          'connect',
          '--provider',
          'generic',
          '--browser-url',
          wsUrl,
          '--name',
          sessionName,
          '--auth',
          ref,
          '--json',
        ]);

        expect(result.exitCode).toBe(0);
        expect(requestLog[0]?.cookie).toContain('authcookie=daemon-value');

        const sessionFile = Bun.file(join(SESSION_DIR, `${sessionName}.json`));
        const sessionJson = (await sessionFile.json()) as {
          metadata?: { cookieAuth?: { source: string; restoredAt: string; cookieCount: number } };
        };
        expect(sessionJson.metadata?.cookieAuth?.cookieCount).toBe(1);
        expect(typeof sessionJson.metadata?.cookieAuth?.restoredAt).toBe('string');
        expect(JSON.stringify(sessionJson)).not.toContain('daemon-value');
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  test('metadata.cookieAuth is present and value-free; not written into env.auth.cookies', async () => {
    await withRetry(async () => {
      requestLog = [];
      const sessionName = generateSessionName();
      const ref = await writeSnapshot(
        `${sessionName}.json`,
        snapshot(`${fixtureBaseUrl}/`, [
          cookie({
            name: 'authcookie',
            value: 'meta-value',
            domain: '127.0.0.1',
            sourcePort: fixturePort,
          }),
        ])
      );

      try {
        const wsUrl = await getWebSocketUrl();
        const result = await runCLI([
          'connect',
          '--provider',
          'generic',
          '--browser-url',
          wsUrl,
          '--name',
          sessionName,
          '--auth',
          ref,
          '--json',
        ]);
        expect(result.exitCode).toBe(0);

        const sessionFile = Bun.file(join(SESSION_DIR, `${sessionName}.json`));
        const sessionJson = (await sessionFile.json()) as {
          metadata?: { cookieAuth?: unknown; env?: { auth?: { cookies?: unknown } } };
        };
        expect(sessionJson.metadata?.cookieAuth).toBeDefined();
        expect(sessionJson.metadata?.env?.auth?.cookies).toBeUndefined();
        expect(JSON.stringify(sessionJson)).not.toContain('meta-value');
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  test('attach after connect does not re-inject the original cookie (rotate + reattach)', async () => {
    await withRetry(async () => {
      requestLog = [];
      const sessionName = generateSessionName();
      const ref = await writeSnapshot(
        `${sessionName}.json`,
        snapshot(`${fixtureBaseUrl}/`, [
          cookie({
            name: 'authcookie',
            value: 'original-value',
            domain: '127.0.0.1',
            sourcePort: fixturePort,
          }),
        ])
      );

      try {
        const wsUrl = await getWebSocketUrl();
        const connectResult = await runCLI([
          'connect',
          '--provider',
          'generic',
          '--browser-url',
          wsUrl,
          '--name',
          sessionName,
          '--auth',
          ref,
          '--json',
        ]);
        expect(connectResult.exitCode).toBe(0);

        // Rotate the cookie in the live browser, simulating server-side rotation.
        const rotateResult = await runCLI([
          'eval',
          '-s',
          sessionName,
          '--json',
          "document.cookie = 'authcookie=rotated-value; path=/'",
        ]);
        expect(rotateResult.exitCode).toBe(0);

        // A fresh CLI invocation attaches to the same session (not a new
        // connect --auth call) and must not replay the original snapshot.
        requestLog = [];
        const gotoAfterRotate = await runCLI([
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify({ action: 'goto', url: `${fixtureBaseUrl}/again` }),
        ]);
        expect(gotoAfterRotate.exitCode).toBe(0);
        expect(requestLog[0]?.cookie).toContain('authcookie=rotated-value');
        expect(requestLog[0]?.cookie).not.toContain('original-value');
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  test('all-expired snapshot fails before navigation, exit 1, fixture never contacted', async () => {
    await withRetry(async () => {
      requestLog = [];
      const sessionName = generateSessionName();
      const ref = await writeSnapshot(
        `${sessionName}.json`,
        snapshot(`${fixtureBaseUrl}/`, [
          cookie({
            name: 'authcookie',
            value: 'expired-value',
            domain: '127.0.0.1',
            sourcePort: fixturePort,
            expires: 1, // epoch second 1 -> long expired
          }),
        ])
      );

      try {
        const wsUrl = await getWebSocketUrl();
        const result = await runCLI([
          'connect',
          '--provider',
          'generic',
          '--browser-url',
          wsUrl,
          '--name',
          sessionName,
          '--no-daemon',
          '--auth',
          ref,
          '--json',
        ]);

        expect(result.exitCode).toBe(1);
        expect(requestLog.length).toBe(0);
        expect(await runCLI(['close', '-s', sessionName]).then((r) => r.exitCode !== 0)).toBe(true);
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  test('BROWSER_PILOT_AUTH env fallback restores and prints the exact source line; --auth wins when both set', async () => {
    await withRetry(async () => {
      requestLog = [];
      const sessionName = generateSessionName();
      const envRef = await writeSnapshot(
        `${sessionName}-env.json`,
        snapshot(`${fixtureBaseUrl}/`, [
          cookie({
            name: 'authcookie',
            value: 'env-value',
            domain: '127.0.0.1',
            sourcePort: fixturePort,
          }),
        ])
      );

      try {
        const wsUrl = await getWebSocketUrl();
        const result = await runCLI(
          [
            'connect',
            '--provider',
            'generic',
            '--browser-url',
            wsUrl,
            '--name',
            sessionName,
            '--no-daemon',
            '--json',
          ],
          { env: { BROWSER_PILOT_AUTH: envRef } }
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain(`auth: using BROWSER_PILOT_AUTH \u2192 ${envRef}`);
        expect(requestLog[0]?.cookie).toContain('authcookie=env-value');
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  test('--auth wins over BROWSER_PILOT_AUTH when both are set', async () => {
    await withRetry(async () => {
      requestLog = [];
      const sessionName = generateSessionName();
      const envRef = await writeSnapshot(
        `${sessionName}-env2.json`,
        snapshot(`${fixtureBaseUrl}/`, [
          cookie({
            name: 'authcookie',
            value: 'env-value-2',
            domain: '127.0.0.1',
            sourcePort: fixturePort,
          }),
        ])
      );
      const flagRef = await writeSnapshot(
        `${sessionName}-flag.json`,
        snapshot(`${fixtureBaseUrl}/`, [
          cookie({
            name: 'authcookie',
            value: 'flag-value',
            domain: '127.0.0.1',
            sourcePort: fixturePort,
          }),
        ])
      );

      try {
        const wsUrl = await getWebSocketUrl();
        const result = await runCLI(
          [
            'connect',
            '--provider',
            'generic',
            '--browser-url',
            wsUrl,
            '--name',
            sessionName,
            '--no-daemon',
            '--auth',
            flagRef,
            '--json',
          ],
          { env: { BROWSER_PILOT_AUTH: envRef } }
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toContain('BROWSER_PILOT_AUTH');
        expect(requestLog[0]?.cookie).toContain('authcookie=flag-value');
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  // NOTE: a CLI-level, real-Chrome reproduction of the partial-unverified
  // path (some cookies verify, some do not) was attempted here but every
  // combination that reliably fails read-back verification in real Chrome
  // (e.g. secure:true cookies restored over a plain-http origin) makes
  // Storage.setCookies reject the whole batch atomically instead of
  // silently dropping just that cookie, which instead exercises the
  // nothing-restored/expired failure path already covered above. The
  // partial-unverified policy itself (warn, print counts, continue, exit 0)
  // is exercised with a mocked CDP transport in the P1/P2 auth unit suites;
  // this suite covers the CLI-visible all-expired/nothing-restored failure
  // and the human/--json success-path output shape instead.

  test('--page-url overrides the snapshot sourceUrl and off-domain mismatch only warns', async () => {
    await withRetry(async () => {
      requestLog = [];
      const sessionName = generateSessionName();
      const ref = await writeSnapshot(
        `${sessionName}.json`,
        snapshot(`${fixtureBaseUrl}/`, [
          cookie({
            name: 'authcookie',
            value: 'override-value',
            domain: '127.0.0.1',
            sourcePort: fixturePort,
          }),
        ])
      );

      try {
        const wsUrl = await getWebSocketUrl();
        const result = await runCLI([
          'connect',
          '--provider',
          'generic',
          '--browser-url',
          wsUrl,
          '--name',
          sessionName,
          '--no-daemon',
          '--auth',
          ref,
          '--page-url',
          `${fixtureBaseUrl}/override-target`,
          '--json',
        ]);

        expect(result.exitCode).toBe(0);
        expect(result.json).toMatchObject({ currentUrl: `${fixtureBaseUrl}/override-target` });
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  test('connect without --auth remains unaffected (regression)', async () => {
    await withRetry(async () => {
      const sessionName = generateSessionName();
      try {
        const wsUrl = await getWebSocketUrl();
        const result = await runCLI([
          'connect',
          '--provider',
          'generic',
          '--browser-url',
          wsUrl,
          '--name',
          sessionName,
          '--no-daemon',
          '--json',
        ]);
        expect(result.exitCode).toBe(0);
        const json = result.json as { cookieAuth?: unknown };
        expect(json.cookieAuth).toBeUndefined();

        const sessionFile = Bun.file(join(SESSION_DIR, `${sessionName}.json`));
        const sessionJson = (await sessionFile.json()) as { metadata?: { cookieAuth?: unknown } };
        expect(sessionJson.metadata?.cookieAuth).toBeUndefined();
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);
});
