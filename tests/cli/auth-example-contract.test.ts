/**
 * Example-contract test for cookie snapshot auth (PLAN.md §3, P7).
 *
 * Every flag documented in `docs/guides/auth-cookies.md` must be recognized by the CLI
 * parsers, and the guide's canonical login -> save -> inspect -> connect --auth flow must
 * actually run against a local fixture server. This is the acceptance test for the docs, not
 * just the feature — if the guide drifts from the implementation, this test should fail.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withRetry } from '../utils/retry.ts';
import { generateSessionName, getWebSocketUrl, runCLI, setup, teardown } from './setup.ts';

const SESSION_DIR = join(homedir(), '.browser-pilot', 'sessions');

async function cleanupSession(sessionName: string): Promise<void> {
  await runCLI(['close', '-s', sessionName]).catch(() => {});
  rmSync(join(SESSION_DIR, sessionName), { recursive: true, force: true });
  rmSync(join(SESSION_DIR, `${sessionName}.json`), { force: true });
}

describe('docs/guides/auth-cookies.md example contract', () => {
  let tmpDir = '';
  let fixtureServer: ReturnType<typeof Bun.serve> | null = null;
  let fixtureBaseUrl = '';
  let sawCookieOnFirstRequest: string | null = null;

  beforeAll(async () => {
    await setup();
    tmpDir = await Bun.$`mktemp -d`.text().then((s) => s.trim());

    fixtureServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const cookie = req.headers.get('cookie');
        if (sawCookieOnFirstRequest === null) {
          sawCookieOnFirstRequest = cookie;
        }
        const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
        // The login page sets its own session cookie via Set-Cookie, exactly like a real
        // login flow — this is what `bp env auth save` is meant to capture.
        if (url.pathname === '/login') {
          headers['set-cookie'] =
            `session=${url.searchParams.get('value') ?? 'logged-in-value'}; Path=/`;
        }
        return new Response(
          `<!doctype html><html><body id="root">dashboard for ${url.pathname}` +
            `<pre id="cookie">${cookie ?? ''}</pre></body></html>`,
          { headers }
        );
      },
    });
    const port = fixtureServer.port;
    if (port === undefined) throw new Error('Expected Bun.serve() to allocate a port');
    fixtureBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    fixtureServer?.stop(true);
    fixtureServer = null;
    rmSync(tmpDir, { recursive: true, force: true });
    await teardown();
  });

  test('documented `bp env auth save|inspect` flags parse without error', async () => {
    // --help output for `bp env` must mention every flag the guide documents.
    const envHelp = await runCLI(['env', '--help']);
    expect(envHelp.exitCode).toBe(0);
    expect(envHelp.stdout).toContain('bp env auth save');
    expect(envHelp.stdout).toContain('bp env auth inspect');
    expect(envHelp.stdout).toContain('--include-url');
    expect(envHelp.stdout).toContain('--force');

    // `save` without a session is a parser-level rejection, not a flag-parsing failure —
    // proves `-s`, `--include-url`, and `--force` are all recognized together.
    const missingSession = await runCLI([
      'env',
      'auth',
      'save',
      'example',
      '--include-url',
      'https://accounts.example.com',
      '--force',
    ]);
    expect(missingSession.exitCode).toBe(1);
    expect(missingSession.stderr.toLowerCase()).toContain('session');

    // `inspect` on a name that resolves but doesn't exist yet: proves the positional +
    // resolver path is recognized (fails on `not_found`, not on argument parsing).
    const inspectMissing = await runCLI(['env', 'auth', 'inspect', 'nonexistent-example-name']);
    expect(inspectMissing.exitCode).toBe(1);
  });

  test('documented `bp connect --auth` flag and `BROWSER_PILOT_AUTH` env var parse without error', async () => {
    const connectHelp = await runCLI(['connect', '--help']);
    expect(connectHelp.exitCode).toBe(0);
    expect(connectHelp.stdout).toContain('--auth <name-or-path>');
    expect(connectHelp.stdout).toContain('BROWSER_PILOT_AUTH');

    // A nonexistent ref fails at file-load time (proves the flag is wired through, not
    // rejected as unknown), never with an "unknown option" style parser error.
    const missingRef = await runCLI(['connect', '--auth', join(tmpDir, 'does-not-exist.json')]);
    expect(missingRef.exitCode).toBe(1);
    expect(missingRef.stderr.toLowerCase()).not.toContain('unknown option');
  });

  test('canonical flow: login -> save -> inspect -> connect --auth restores the session', async () => {
    await withRetry(async () => {
      const loginSession = generateSessionName();
      const workSession = generateSessionName();
      const authName = `example-contract-${Date.now()}`;
      const authFile = join(homedir(), '.browser-pilot', 'auth', `${authName}.json`);

      try {
        // Step 1 (guide): "one-time: log in like a human" — connect and land on the
        // "authenticated" fixture page, which sets a session cookie via Set-Cookie is not
        // modeled here; instead we drive the browser to set its own cookie via document.cookie
        // to keep the fixture dependency-free, then capture it exactly as a real login would
        // leave real session cookies in the jar.
        const wsUrl = await getWebSocketUrl();
        const loginConnect = await runCLI([
          'connect',
          '--provider',
          'generic',
          '--browser-url',
          wsUrl,
          '--name',
          loginSession,
          '--no-daemon',
          '--new-tab',
          '--page-url',
          `${fixtureBaseUrl}/login?value=logged-in-value`,
          '--json',
        ]);
        expect(loginConnect.exitCode).toBe(0);

        // Step 2 (guide): `bp env auth save <name> -s <session>`.
        const save = await runCLI(['env', 'auth', 'save', authName, '-s', loginSession, '--json']);
        expect(save.exitCode).toBe(0);
        const saveJson = save.json as { cookieCount: number; file: string };
        expect(saveJson.cookieCount).toBeGreaterThanOrEqual(1);

        // Step 3 (guide): `bp env auth inspect <name>` — fully offline, no values shown.
        const inspect = await runCLI(['env', 'auth', 'inspect', authName, '--json']);
        expect(inspect.exitCode).toBe(0);
        const inspectJson = inspect.json as { cookieCount: number; domains: string[] };
        expect(inspectJson.cookieCount).toBeGreaterThanOrEqual(1);
        expect(inspect.stdout).not.toContain('logged-in-value');

        // Step 4 (guide): `bp connect --name work --auth <name>` restores into a fresh tab
        // before the first navigation.
        sawCookieOnFirstRequest = null;
        const workConnect = await runCLI([
          'connect',
          '--provider',
          'generic',
          '--browser-url',
          wsUrl,
          '--name',
          workSession,
          '--no-daemon',
          '--auth',
          authName,
          '--page-url',
          `${fixtureBaseUrl}/dashboard`,
          '--json',
        ]);
        expect(workConnect.exitCode).toBe(0);
        const workJson = workConnect.json as {
          cookieAuth?: { restored: number; skippedExpired: number };
        };
        expect(workJson.cookieAuth?.restored).toBeGreaterThanOrEqual(1);
        expect(sawCookieOnFirstRequest as string | null).toContain('session=logged-in-value');

        // Guide's renewal step: `--force` overwrites the existing snapshot.
        const renew = await runCLI([
          'env',
          'auth',
          'save',
          authName,
          '-s',
          loginSession,
          '--force',
        ]);
        expect(renew.exitCode).toBe(0);
        const renewAgainFails = await runCLI(['env', 'auth', 'save', authName, '-s', loginSession]);
        expect(renewAgainFails.exitCode).toBe(1);
      } finally {
        await cleanupSession(loginSession);
        await cleanupSession(workSession);
        rmSync(authFile, { force: true });
      }
    });
  }, 120000);

  test('explicit file path form from the guide works end-to-end (save + connect --auth)', async () => {
    await withRetry(async () => {
      const loginSession = generateSessionName();
      const workSession = generateSessionName();
      const authPath = join(tmpDir, `${loginSession}.cookies.json`);

      try {
        const wsUrl = await getWebSocketUrl();
        const loginConnect = await runCLI([
          'connect',
          '--provider',
          'generic',
          '--browser-url',
          wsUrl,
          '--name',
          loginSession,
          '--no-daemon',
          '--new-tab',
          '--page-url',
          `${fixtureBaseUrl}/login?value=file-path-value`,
        ]);
        expect(loginConnect.exitCode).toBe(0);

        const save = await runCLI(['env', 'auth', 'save', authPath, '-s', loginSession]);
        expect(save.exitCode).toBe(0);

        const connect = await runCLI([
          'connect',
          '--provider',
          'generic',
          '--browser-url',
          wsUrl,
          '--name',
          workSession,
          '--no-daemon',
          '--auth',
          authPath,
          '--page-url',
          `${fixtureBaseUrl}/dashboard`,
        ]);
        expect(connect.exitCode).toBe(0);
      } finally {
        await cleanupSession(loginSession);
        await cleanupSession(workSession);
        rmSync(authPath, { force: true });
      }
    });
  }, 120000);

  test('BROWSER_PILOT_AUTH env fallback from the guide/CI section is honored', async () => {
    await withRetry(async () => {
      const loginSession = generateSessionName();
      const ciSession = generateSessionName();
      const authPath = join(tmpDir, `${loginSession}-ci.cookies.json`);

      try {
        const wsUrl = await getWebSocketUrl();
        const loginConnect = await runCLI([
          'connect',
          '--provider',
          'generic',
          '--browser-url',
          wsUrl,
          '--name',
          loginSession,
          '--no-daemon',
          '--new-tab',
          '--page-url',
          `${fixtureBaseUrl}/login?value=ci-value`,
        ]);
        expect(loginConnect.exitCode).toBe(0);

        const save = await runCLI(['env', 'auth', 'save', authPath, '-s', loginSession]);
        expect(save.exitCode).toBe(0);

        const ciConnect = await runCLI(
          [
            'connect',
            '--provider',
            'generic',
            '--browser-url',
            wsUrl,
            '--name',
            ciSession,
            '--no-daemon',
            '--page-url',
            `${fixtureBaseUrl}/dashboard`,
          ],
          { env: { BROWSER_PILOT_AUTH: authPath } }
        );
        expect(ciConnect.exitCode).toBe(0);
        expect(ciConnect.stderr).toContain('auth: using BROWSER_PILOT_AUTH');
      } finally {
        await cleanupSession(loginSession);
        await cleanupSession(ciSession);
        rmSync(authPath, { force: true });
      }
    });
  }, 120000);
});
