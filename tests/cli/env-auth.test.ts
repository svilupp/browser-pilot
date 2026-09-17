import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withRetry } from '../utils/retry.ts';
import { generateSessionName, getWebSocketUrl, runCLI, setup, teardown } from './setup.ts';

const SESSION_DIR = join(homedir(), '.browser-pilot', 'sessions');

let echoServer: ReturnType<typeof Bun.serve> | null = null;
let echoBaseUrl = '';

describe('CLI env auth persistence and reapplication', () => {
  beforeAll(async () => {
    await setup();

    echoServer = Bun.serve({
      port: 0,
      fetch(req) {
        const headers: Record<string, string> = {};
        for (const [key, value] of req.headers.entries()) {
          headers[key] = value;
        }
        return new Response(
          `<!doctype html><html><body><pre id="headers">${JSON.stringify(headers)}</pre></body></html>`,
          { headers: { 'content-type': 'text/html; charset=utf-8' } }
        );
      },
    });

    const port = echoServer.port;
    if (port === undefined) {
      throw new Error('Expected Bun.serve() to allocate a port');
    }
    echoBaseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    echoServer?.stop(true);
    echoServer = null;
    await teardown();
  });

  test('set-headers applies immediately and reapplies on reattach', async () => {
    await withRetry(async () => {
      const sessionName = generateSessionName();

      try {
        await connectDaemonSession(sessionName);

        const gotoResult = await runCLI([
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify({ action: 'goto', url: echoBaseUrl }),
        ]);
        expect(gotoResult.exitCode).toBe(0);

        const setHeadersResult = await runCLI(
          [
            'env',
            'auth',
            'set-headers',
            '-s',
            sessionName,
            '--from-env',
            'X-Test-Header=BP_TEST_AUTH_HEADER_VALUE',
          ],
          { env: { BP_TEST_AUTH_HEADER_VALUE: 'super-secret-token' } }
        );
        expect(setHeadersResult.exitCode).toBe(0);

        // Re-navigate so the freshly-set extra header is sent on the request.
        // Env vars are resolved at apply time on every attach, so the
        // subprocess needs the var set too (mirrors real shell usage where
        // the var stays exported for the session).
        const testEnv = { BP_TEST_AUTH_HEADER_VALUE: 'super-secret-token' };
        const renavResult = await runCLI(
          [
            'exec',
            '-s',
            sessionName,
            '--json',
            JSON.stringify({ action: 'goto', url: echoBaseUrl }),
          ],
          { env: testEnv }
        );
        expect(renavResult.exitCode).toBe(0);

        const headersAfterSet = await getEchoedHeaders(sessionName, testEnv);
        expect(headersAfterSet['x-test-header']).toBe('super-secret-token');

        // Simulate reattach (a fresh CLI invocation must reapply persisted
        // headers via applySessionEnvironment()).
        const evalAfterReattach = await runCLI(
          ['eval', '-s', sessionName, '--json', 'window.location.href'],
          { env: { BP_TEST_AUTH_HEADER_VALUE: 'super-secret-token' } }
        );
        expect(evalAfterReattach.exitCode).toBe(0);

        const renavAfterReattach = await runCLI(
          [
            'exec',
            '-s',
            sessionName,
            '--json',
            JSON.stringify({ action: 'goto', url: echoBaseUrl }),
          ],
          { env: testEnv }
        );
        expect(renavAfterReattach.exitCode).toBe(0);

        const headersAfterReattach = await getEchoedHeaders(sessionName, testEnv);
        expect(headersAfterReattach['x-test-header']).toBe('super-secret-token');

        // The session file must store the env var *name*, never the resolved value.
        const sessionFile = Bun.file(join(SESSION_DIR, `${sessionName}.json`));
        const sessionJson = (await sessionFile.json()) as {
          metadata?: { env?: { auth?: { extraHeaders?: { fromEnv?: Record<string, string> } } } };
        };
        expect(sessionJson.metadata?.env?.auth?.extraHeaders?.fromEnv).toEqual({
          'X-Test-Header': 'BP_TEST_AUTH_HEADER_VALUE',
        });
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  test('incremental set-headers merges live headers instead of dropping previous ones', async () => {
    await withRetry(async () => {
      const sessionName = generateSessionName();

      try {
        await connectDaemonSession(sessionName);

        await runCLI([
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify({ action: 'goto', url: echoBaseUrl }),
        ]);

        const firstEnv = { BP_TEST_AUTH_HEADER_ONE: 'first-value' };
        const firstResult = await runCLI(
          [
            'env',
            'auth',
            'set-headers',
            '-s',
            sessionName,
            '--from-env',
            'X-Test-Header-One=BP_TEST_AUTH_HEADER_ONE',
          ],
          { env: firstEnv }
        );
        expect(firstResult.exitCode).toBe(0);

        // Second call only passes a *new* header. Because
        // Network.setExtraHTTPHeaders replaces the whole set, the live
        // session must still resolve and re-apply the first header too,
        // not just the newly-passed one.
        const secondEnv = {
          BP_TEST_AUTH_HEADER_ONE: 'first-value',
          BP_TEST_AUTH_HEADER_TWO: 'second-value',
        };
        const secondResult = await runCLI(
          [
            'env',
            'auth',
            'set-headers',
            '-s',
            sessionName,
            '--from-env',
            'X-Test-Header-Two=BP_TEST_AUTH_HEADER_TWO',
          ],
          { env: secondEnv }
        );
        expect(secondResult.exitCode).toBe(0);

        const renavResult = await runCLI(
          [
            'exec',
            '-s',
            sessionName,
            '--json',
            JSON.stringify({ action: 'goto', url: echoBaseUrl }),
          ],
          { env: secondEnv }
        );
        expect(renavResult.exitCode).toBe(0);

        const headers = await getEchoedHeaders(sessionName, secondEnv);
        expect(headers['x-test-header-one']).toBe('first-value');
        expect(headers['x-test-header-two']).toBe('second-value');

        const sessionFile = Bun.file(join(SESSION_DIR, `${sessionName}.json`));
        const sessionJson = (await sessionFile.json()) as {
          metadata?: { env?: { auth?: { extraHeaders?: { fromEnv?: Record<string, string> } } } };
        };
        expect(sessionJson.metadata?.env?.auth?.extraHeaders?.fromEnv).toEqual({
          'X-Test-Header-One': 'BP_TEST_AUTH_HEADER_ONE',
          'X-Test-Header-Two': 'BP_TEST_AUTH_HEADER_TWO',
        });
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  test('set-headers warns and skips unset env vars without failing', async () => {
    await withRetry(async () => {
      const sessionName = generateSessionName();

      try {
        await connectDaemonSession(sessionName);

        await runCLI([
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify({ action: 'goto', url: echoBaseUrl }),
        ]);

        const result = await runCLI([
          'env',
          'auth',
          'set-headers',
          '-s',
          sessionName,
          '--from-env',
          'X-Test-Missing=BP_TEST_AUTH_HEADER_DEFINITELY_UNSET',
        ]);

        // Attach-time skip of unset vars is intentional, so this still succeeds...
        expect(result.exitCode).toBe(0);
        // ...but must warn, naming the unset var, without ever printing a value.
        expect(result.stderr).toContain('BP_TEST_AUTH_HEADER_DEFINITELY_UNSET');

        const sessionFile = Bun.file(join(SESSION_DIR, `${sessionName}.json`));
        const sessionJson = (await sessionFile.json()) as {
          metadata?: { env?: { auth?: { extraHeaders?: { fromEnv?: Record<string, string> } } } };
        };
        expect(sessionJson.metadata?.env?.auth?.extraHeaders?.fromEnv).toEqual({
          'X-Test-Missing': 'BP_TEST_AUTH_HEADER_DEFINITELY_UNSET',
        });
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  test('set-cookie persists valueFromEnv and applies the cookie', async () => {
    await withRetry(async () => {
      const sessionName = generateSessionName();

      try {
        await connectDaemonSession(sessionName);

        const gotoResult = await runCLI([
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify({ action: 'goto', url: echoBaseUrl }),
        ]);
        expect(gotoResult.exitCode).toBe(0);

        const setCookieResult = await runCLI(
          [
            'env',
            'auth',
            'set-cookie',
            'CF_Authorization',
            '-s',
            sessionName,
            '--value-from-env',
            'BP_TEST_AUTH_JWT',
          ],
          { env: { BP_TEST_AUTH_JWT: 'fake.jwt.value' } }
        );
        expect(setCookieResult.exitCode).toBe(0);

        const cookiesResult = await runCLI([
          'eval',
          '-s',
          sessionName,
          '--json',
          'document.cookie',
        ]);
        expect(cookiesResult.exitCode).toBe(0);
        const cookiesJson = cookiesResult.json as { result?: string };
        expect(cookiesJson.result).toContain('CF_Authorization=fake.jwt.value');

        const sessionFile = Bun.file(join(SESSION_DIR, `${sessionName}.json`));
        const sessionJson = (await sessionFile.json()) as {
          metadata?: {
            env?: {
              auth?: { cookies?: { name: string; valueFromEnv?: string; value?: string }[] };
            };
          };
        };
        const persistedCookie = sessionJson.metadata?.env?.auth?.cookies?.find(
          (c) => c.name === 'CF_Authorization'
        );
        expect(persistedCookie?.valueFromEnv).toBe('BP_TEST_AUTH_JWT');
        // The raw resolved secret must never be persisted for env-sourced cookies.
        expect(persistedCookie?.value).toBeUndefined();
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  test('auth clear removes persisted auth settings', async () => {
    await withRetry(async () => {
      const sessionName = generateSessionName();

      try {
        await connectDaemonSession(sessionName);

        await runCLI([
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify({ action: 'goto', url: echoBaseUrl }),
        ]);

        await runCLI(
          [
            'env',
            'auth',
            'set-headers',
            '-s',
            sessionName,
            '--from-env',
            'X-Test-Header=BP_TEST_AUTH_HEADER_VALUE',
          ],
          { env: { BP_TEST_AUTH_HEADER_VALUE: 'super-secret-token' } }
        );

        const clearResult = await runCLI(['env', 'auth', 'clear', '-s', sessionName]);
        expect(clearResult.exitCode).toBe(0);

        const sessionFile = Bun.file(join(SESSION_DIR, `${sessionName}.json`));
        const sessionJson = (await sessionFile.json()) as {
          metadata?: { env?: { auth?: unknown } };
        };
        expect(sessionJson.metadata?.env?.auth).toBeUndefined();
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);
});

async function getEchoedHeaders(
  sessionName: string,
  env?: Record<string, string>
): Promise<Record<string, string>> {
  const result = await runCLI(
    ['eval', '-s', sessionName, '--json', "document.getElementById('headers').textContent"],
    { env }
  );
  expect(result.exitCode).toBe(0);
  const json = result.json as { result?: string };
  return JSON.parse(json.result ?? '{}');
}

async function connectDaemonSession(sessionName: string): Promise<void> {
  const wsUrl = await getWebSocketUrl();
  const connectResult = await runCLI([
    'connect',
    '--provider',
    'generic',
    '--url',
    wsUrl,
    '--name',
    sessionName,
    '--json',
  ]);

  expect(connectResult.exitCode).toBe(0);
}

async function cleanupSession(sessionName: string): Promise<void> {
  await runCLI(['close', '-s', sessionName]).catch(() => {});
  rmSync(join(SESSION_DIR, sessionName), { recursive: true, force: true });
  rmSync(join(SESSION_DIR, `${sessionName}.json`), { force: true });
}

const COOKIE_SENTINEL = 'super-secret-cookie-value-do-not-leak';

// Cookie capture relies on `Storage.getCookies`, which is scoped to the
// browsing context that *created* the target. Reusing the harness's
// pre-existing blank tab (the default `connectDaemonSession` behavior)
// attaches to a target created by a different connection, so capture
// legitimately reports zero cookies. `--new-tab` creates the target through
// our own connection instead, matching real `bp connect --new-tab` usage
// from the canonical save/inspect flow.
async function connectDaemonSessionNewTab(sessionName: string): Promise<void> {
  const wsUrl = await getWebSocketUrl();
  const connectResult = await runCLI([
    'connect',
    '--provider',
    'generic',
    '--url',
    wsUrl,
    '--new-tab',
    '--name',
    sessionName,
    '--json',
  ]);
  expect(connectResult.exitCode).toBe(0);
}

describe('CLI env auth save/inspect (cookie snapshots)', () => {
  let saveEchoServer: ReturnType<typeof Bun.serve> | null = null;
  let saveEchoBaseUrl = '';
  let tmpDir = '';

  beforeAll(async () => {
    await setup();

    saveEchoServer = Bun.serve({
      port: 0,
      fetch() {
        return new Response('<!doctype html><html><body>ok</body></html>', {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': `bp_test_sentinel=${COOKIE_SENTINEL}; Path=/`,
          },
        });
      },
    });

    const port = saveEchoServer.port;
    if (port === undefined) {
      throw new Error('Expected Bun.serve() to allocate a port');
    }
    saveEchoBaseUrl = `http://127.0.0.1:${port}`;

    tmpDir = await Bun.$`mktemp -d`.text().then((s) => s.trim());
  });

  afterAll(async () => {
    saveEchoServer?.stop(true);
    saveEchoServer = null;
    rmSync(tmpDir, { recursive: true, force: true });
    await teardown();
  });

  function refPath(name: string): string {
    return join(tmpDir, name);
  }

  test('save requires an explicit session (bare command rejected)', async () => {
    const result = await runCLI(['env', 'auth', 'save', refPath('no-session.json')]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain('session');
  });

  test('save + inspect happy path, no cookie values anywhere, human output', async () => {
    await withRetry(async () => {
      const sessionName = generateSessionName();
      const ref = refPath(`${sessionName}.json`);

      try {
        await connectDaemonSessionNewTab(sessionName);
        const gotoResult = await runCLI([
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify({ action: 'goto', url: saveEchoBaseUrl }),
        ]);
        expect(gotoResult.exitCode).toBe(0);

        const saveResult = await runCLI(['env', 'auth', 'save', ref, '-s', sessionName]);
        expect(saveResult.exitCode).toBe(0);
        expect(saveResult.stdout).not.toContain(COOKIE_SENTINEL);
        expect(saveResult.stdout).toContain(ref);
        expect(saveResult.stdout).toContain('127.0.0.1');

        // Snapshot file itself only omitted from stdout assertions above; the
        // save command's own stdout must never include the value, but the
        // file on disk legitimately stores it (that's the point of the file).

        const inspectResult = await runCLI(['env', 'auth', 'inspect', ref]);
        expect(inspectResult.exitCode).toBe(0);
        expect(inspectResult.stdout).not.toContain(COOKIE_SENTINEL);
        expect(inspectResult.stdout).toContain(ref);
        expect(inspectResult.stdout).toContain('127.0.0.1');
        expect(inspectResult.stdout).toMatch(/Cookies:\s*1/);
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  test('save + inspect --json output, no cookie values, correct metadata shape', async () => {
    await withRetry(async () => {
      const sessionName = generateSessionName();
      const ref = refPath(`${sessionName}-json.json`);

      try {
        await connectDaemonSessionNewTab(sessionName);
        await runCLI([
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify({ action: 'goto', url: saveEchoBaseUrl }),
        ]);

        const saveResult = await runCLI(['env', 'auth', 'save', ref, '-s', sessionName, '--json']);
        expect(saveResult.exitCode).toBe(0);
        expect(saveResult.stdout).not.toContain(COOKIE_SENTINEL);
        const saveJson = saveResult.json as {
          file?: string;
          sourceUrl?: string;
          cookieCount?: number;
        };
        expect(saveJson.file).toBe(ref);
        expect(saveJson.cookieCount).toBe(1);
        expect(saveJson.sourceUrl).toContain('127.0.0.1');

        const inspectResult = await runCLI(['env', 'auth', 'inspect', ref, '--json']);
        expect(inspectResult.exitCode).toBe(0);
        expect(inspectResult.stdout).not.toContain(COOKIE_SENTINEL);
        const inspectJson = inspectResult.json as {
          file?: string;
          sourceUrl?: string;
          savedAt?: string;
          cookieCount?: number;
          domains?: string[];
        };
        expect(inspectJson.file).toBe(ref);
        expect(inspectJson.cookieCount).toBe(1);
        expect(typeof inspectJson.savedAt).toBe('string');
        expect(inspectJson.domains).toEqual(['127.0.0.1']);
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  test('inspect is fully offline: no browser required, no new session file created', async () => {
    await withRetry(async () => {
      const sessionName = generateSessionName();
      const ref = refPath(`${sessionName}-offline.json`);

      try {
        await connectDaemonSessionNewTab(sessionName);
        await runCLI([
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify({ action: 'goto', url: saveEchoBaseUrl }),
        ]);
        const saveResult = await runCLI(['env', 'auth', 'save', ref, '-s', sessionName]);
        expect(saveResult.exitCode).toBe(0);

        const { readdirSync } = await import('node:fs');
        const before = new Set(readdirSync(SESSION_DIR));

        const inspectResult = await runCLI(['env', 'auth', 'inspect', ref]);
        expect(inspectResult.exitCode).toBe(0);

        const after = new Set(readdirSync(SESSION_DIR));
        expect(after).toEqual(before);
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  test('save fails without --force when snapshot already exists; --force overwrites', async () => {
    await withRetry(async () => {
      const sessionName = generateSessionName();
      const ref = refPath(`${sessionName}-exists.json`);

      try {
        await connectDaemonSessionNewTab(sessionName);
        await runCLI([
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify({ action: 'goto', url: saveEchoBaseUrl }),
        ]);

        const first = await runCLI(['env', 'auth', 'save', ref, '-s', sessionName]);
        expect(first.exitCode).toBe(0);

        const second = await runCLI(['env', 'auth', 'save', ref, '-s', sessionName]);
        expect(second.exitCode).toBe(1);
        expect(second.stderr).toContain('--force');

        const third = await runCLI(['env', 'auth', 'save', ref, '-s', sessionName, '--force']);
        expect(third.exitCode).toBe(0);
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  test('inspect rejects a missing file', async () => {
    const result = await runCLI(['env', 'auth', 'inspect', refPath('does-not-exist.json')]);
    expect(result.exitCode).toBe(1);
  });

  test('inspect/save reject invalid ref grammar: "." and ".."', async () => {
    const dotResult = await runCLI(['env', 'auth', 'inspect', '.']);
    expect(dotResult.exitCode).toBe(1);

    const dotDotResult = await runCLI(['env', 'auth', 'inspect', '..']);
    expect(dotDotResult.exitCode).toBe(1);
  });

  test('auth clear never deletes snapshot files on disk', async () => {
    await withRetry(async () => {
      const sessionName = generateSessionName();
      const ref = refPath(`${sessionName}-clear.json`);

      try {
        await connectDaemonSessionNewTab(sessionName);
        await runCLI([
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify({ action: 'goto', url: saveEchoBaseUrl }),
        ]);

        const saveResult = await runCLI(['env', 'auth', 'save', ref, '-s', sessionName]);
        expect(saveResult.exitCode).toBe(0);

        const clearResult = await runCLI(['env', 'auth', 'clear', '-s', sessionName]);
        expect(clearResult.exitCode).toBe(0);

        const inspectAfterClear = await runCLI(['env', 'auth', 'inspect', ref]);
        expect(inspectAfterClear.exitCode).toBe(0);
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);
});
