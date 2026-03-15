import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { withRetry } from '../utils/retry.ts';
import { generateSessionName, getWebSocketUrl, runCLI, setup, teardown } from './setup.ts';

const SESSION_DIR = join(homedir(), '.browser-pilot', 'sessions');

let realtimeServer: ReturnType<typeof Bun.serve> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let loopbackBaseUrl = '';
let lanBaseUrl = '';
let lanHost = '127.0.0.1';

interface ExecStepResultJson {
  payload?: string;
  requestId?: string;
}

interface ExecStepJson extends Record<string, unknown> {
  text?: string;
  result?: ExecStepResultJson;
}

describe('CLI env and trace regression coverage', () => {
  beforeAll(async () => {
    await setup();

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>browser-pilot realtime test page</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 24px; }
      .row { margin-bottom: 12px; }
      button { margin-right: 8px; }
      code { background: #f3f4f6; padding: 2px 6px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <h1>browser-pilot realtime test page</h1>
    <div class="row">WS status: <code id="status">Connecting</code></div>
    <div class="row">Visibility: <code id="visibility">Visible</code></div>
    <div class="row">Geo: <code id="geo">Pending</code> <button id="geo-btn">Read geolocation</button></div>
    <div class="row">Ping: <code id="ping">Idle</code> <button id="ping-btn">Ping server</button></div>
    <script>
      const statusEl = document.getElementById('status');
      const visibilityEl = document.getElementById('visibility');
      const geoEl = document.getElementById('geo');
      const pingEl = document.getElementById('ping');
      const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
      let socket;
      let heartbeatCount = 0;

      function connect() {
        socket = new WebSocket(wsUrl);
        socket.addEventListener('open', () => {
          statusEl.textContent = 'Live';
        });
        socket.addEventListener('message', (event) => {
          const data = JSON.parse(event.data);
          if (data.type === 'heartbeat') {
            heartbeatCount = data.n;
          }
        });
        socket.addEventListener('close', () => {
          statusEl.textContent = 'Closed';
          setTimeout(connect, 300);
        });
      }

      connect();

      document.addEventListener('visibilitychange', () => {
        visibilityEl.textContent = document.visibilityState === 'hidden' ? 'Hidden' : 'Visible';
      });

      document.getElementById('geo-btn').addEventListener('click', () => {
        geoEl.textContent = 'Loading';
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            geoEl.textContent = pos.coords.latitude.toFixed(3) + ',' + pos.coords.longitude.toFixed(3);
          },
          (err) => {
            geoEl.textContent = 'Error:' + err.code;
          },
          { timeout: 5000 }
        );
      });

      document.getElementById('ping-btn').addEventListener('click', async () => {
        const start = performance.now();
        await fetch('/ping?heartbeat=' + heartbeatCount + '&t=' + Date.now(), { cache: 'no-store' });
        pingEl.textContent = Math.round(performance.now() - start) + 'ms';
      });
    </script>
  </body>
</html>`;

    const clients = new Set<Bun.ServerWebSocket<unknown>>();
    let heartbeat = 0;

    realtimeServer = Bun.serve({
      port: 0,
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === '/ws') {
          if (server.upgrade(req, { data: undefined })) {
            return undefined;
          }
          return new Response('upgrade failed', { status: 400 });
        }
        if (url.pathname === '/ping') {
          return new Response(JSON.stringify({ ok: true, heartbeat }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(html, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
      websocket: {
        message() {},
        open(ws) {
          clients.add(ws);
          ws.send(JSON.stringify({ type: 'session.ready', ts: Date.now() }));
        },
        close(ws) {
          clients.delete(ws);
        },
      },
    });

    heartbeatTimer = setInterval(() => {
      heartbeat += 1;
      const payload = JSON.stringify({ type: 'heartbeat', n: heartbeat, ts: Date.now() });
      for (const ws of clients) {
        ws.send(payload);
      }
    }, 150);

    const serverPort = realtimeServer.port;
    if (serverPort === undefined) {
      throw new Error('Expected Bun.serve() to allocate a port');
    }
    loopbackBaseUrl = `http://127.0.0.1:${serverPort}`;
    lanHost = await resolveReachableHost(serverPort);
    lanBaseUrl = `http://${lanHost}:${serverPort}`;
  });

  afterAll(async () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    realtimeServer?.stop(true);
    realtimeServer = null;
    await teardown();
  });

  test('uses the default daemon path for hot-socket waits and trace-backed assertions', async () => {
    await withRetry(async () => {
      const sessionName = generateSessionName();

      try {
        await connectDaemonSession(sessionName);

        const openResult = await runCLI([
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify([
            { action: 'goto', url: loopbackBaseUrl },
            {
              action: 'assertTextChanged',
              selector: '#status',
              from: 'Connecting',
              to: 'Live',
              timeout: 5000,
            },
          ]),
        ]);
        const openJson = expectExecSuccess(openResult);
        expect(openJson.steps[1]?.text).toBe('Live');

        const waitResult = await runCLI([
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify([
            {
              action: 'waitForWsMessage',
              match: '*',
              where: { type: 'heartbeat' },
              timeout: 5000,
            },
            { action: 'assertNoConsoleErrors', windowMs: 300 },
          ]),
        ]);
        const waitJson = expectExecSuccess(waitResult);
        expect(waitJson.steps[0]?.result?.payload).toContain('"type":"heartbeat"');
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  test('persists granted permissions, geolocation, and visibility across daemon-backed commands', async () => {
    await withRetry(async () => {
      const sessionName = generateSessionName();

      try {
        await connectDaemonSession(sessionName);

        const gotoResult = await runCLI([
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify({ action: 'goto', url: loopbackBaseUrl }),
        ]);
        expectExecSuccess(gotoResult);

        expect(
          (await runCLI(['env', 'permissions', 'grant', 'geolocation', '-s', sessionName])).exitCode
        ).toBe(0);
        expect(
          (await runCLI(['env', 'permissions', 'grant', 'microphone', '-s', sessionName])).exitCode
        ).toBe(0);
        const geolocationSet = await runCLI([
          'env',
          'geolocation',
          'set',
          '-s',
          sessionName,
          '--lat',
          '51.5010',
          '--lon',
          '-0.1416',
          '--json',
        ]);
        expect(geolocationSet.exitCode).toBe(0);
        expect(geolocationSet.stdout).toContain('51.501');
        expect(geolocationSet.stdout).toContain('-0.1416');

        const permissionResult = await runCLI([
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify([
            { action: 'assertPermission', name: 'geolocation', state: 'granted' },
            { action: 'assertPermission', name: 'microphone', state: 'granted' },
          ]),
        ]);
        const permissionJson = expectExecSuccess(permissionResult);
        expect(permissionJson.steps).toHaveLength(2);

        const originResult = await runCLI(['eval', '-s', sessionName, '--json', 'location.origin']);
        expect(expectEvalResult(originResult)).toBe(new URL(loopbackBaseUrl).origin);

        expect((await runCLI(['env', 'visibility', 'hidden', '-s', sessionName])).exitCode).toBe(0);
        const hiddenResult = await runCLI([
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify({
            action: 'assertTextChanged',
            selector: '#visibility',
            from: 'Visible',
            to: 'Hidden',
            timeout: 5000,
          }),
        ]);
        expectExecSuccess(hiddenResult);

        const hiddenState = await runCLI([
          'eval',
          '-s',
          sessionName,
          '--json',
          'document.visibilityState',
        ]);
        expect(expectEvalResult(hiddenState)).toBe('hidden');

        expect((await runCLI(['env', 'visibility', 'visible', '-s', sessionName])).exitCode).toBe(
          0
        );
        const visibleResult = await runCLI([
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify({
            action: 'assertTextChanged',
            selector: '#visibility',
            from: 'Hidden',
            to: 'Visible',
            timeout: 5000,
          }),
        ]);
        expectExecSuccess(visibleResult);

        const visibleState = await runCLI([
          'eval',
          '-s',
          sessionName,
          '--json',
          'document.visibilityState',
        ]);
        expect(expectEvalResult(visibleState)).toBe('visible');
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  test('applies offline and throttle network overrides to fetch requests', async () => {
    await withRetry(async () => {
      const sessionName = generateSessionName();

      try {
        await connectDaemonSession(sessionName);

        const gotoResult = await runCLI([
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify({ action: 'goto', url: loopbackBaseUrl }),
        ]);
        expectExecSuccess(gotoResult);

        const baseline = await runCLI([
          'eval',
          '-s',
          sessionName,
          '--json',
          "(async () => { try { await fetch('/ping?baseline=' + Date.now(), { cache: 'no-store' }); return 'ok'; } catch (error) { return 'err:' + String(error && error.message ? error.message : error); } })()",
        ]);
        expect(expectEvalResult(baseline)).toBe('ok');

        expect((await runCLI(['env', 'network', 'offline', '-s', sessionName])).exitCode).toBe(0);
        const offline = await runCLI([
          'eval',
          '-s',
          sessionName,
          '--json',
          "(async () => { try { await fetch('/ping?offline=' + Date.now(), { cache: 'no-store' }); return 'ok'; } catch (error) { return 'err:' + String(error && error.message ? error.message : error); } })()",
        ]);
        expect(expectEvalResult(offline)).toBe('err:Failed to fetch');

        expect((await runCLI(['env', 'network', 'online', '-s', sessionName])).exitCode).toBe(0);
        expect(
          (
            await runCLI([
              'env',
              'network',
              'throttle',
              '-s',
              sessionName,
              '--latency',
              '250',
              '--down',
              '128kbps',
              '--up',
              '64kbps',
            ])
          ).exitCode
        ).toBe(0);

        const throttled = await runCLI([
          'eval',
          '-s',
          sessionName,
          '--json',
          "(async () => { const start = performance.now(); await fetch('/ping?throttle=' + Date.now(), { cache: 'no-store' }); return Math.round(performance.now() - start); })()",
        ]);
        expect(Number(expectEvalResult(throttled))).toBeGreaterThanOrEqual(200);

        expect((await runCLI(['env', 'network', 'online', '-s', sessionName])).exitCode).toBe(0);
      } finally {
        await cleanupSession(sessionName);
      }
    });
  }, 90000);

  test('captures websocket traffic from an already-live session in trace output', async () => {
    await withRetry(
      async () => {
        const sessionName = generateSessionName();
        const wsMatch = `*${new URL(lanBaseUrl).host}/ws*`;
        const tracePath = join(
          SESSION_DIR,
          sessionName,
          `trace-reconnect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`
        );

        try {
          await connectDaemonSession(sessionName);

          const initialResult = await runCLI([
            'exec',
            '-s',
            sessionName,
            '--json',
            JSON.stringify([
              { action: 'goto', url: lanBaseUrl },
              {
                action: 'waitForWsMessage',
                match: wsMatch,
                where: { type: 'session.ready' },
                timeout: 5000,
              },
              {
                action: 'assertTextChanged',
                selector: '#status',
                from: 'Connecting',
                to: 'Live',
                timeout: 5000,
              },
            ]),
          ]);
          const initialJson = expectExecSuccess(initialResult);
          expect(String(initialJson.steps[1]?.result?.requestId ?? '').length).toBeGreaterThan(0);

          const traceProc = spawnCLI([
            'trace',
            'start',
            '-s',
            sessionName,
            '--timeout',
            '2500',
            '-o',
            tracePath,
            '--json',
          ]);

          await Bun.sleep(1000);

          const traceResult = await collectProcess(traceProc);
          expect(traceResult.exitCode).toBe(0);
          expect(existsSync(tracePath)).toBe(true);

          const traceSummaryResult = await runCLI([
            'trace',
            'summary',
            tracePath,
            '--view',
            'ws',
            '--json',
          ]);
          expect(traceSummaryResult.exitCode).toBe(0);
          const traceSummaryJson = traceSummaryResult.json as {
            summary?: { totalEvents?: number; connections?: unknown[] };
          };
          expect(Number(traceSummaryJson.summary?.totalEvents ?? 0)).toBeGreaterThan(0);
          expect(Array.isArray(traceSummaryJson.summary?.connections)).toBe(true);

          const analysis = analyzeTraceWindow(tracePath);
          expect(analysis.receivedCount).toBeGreaterThan(0);
        } finally {
          await cleanupSession(sessionName);
        }
      },
      { retries: 1 }
    );
  }, 90000);
});

async function resolveReachableHost(port: number): Promise<string> {
  const candidates = [
    ...new Set(
      Object.values(networkInterfaces())
        .flat()
        .filter(
          (
            entry
          ): entry is NonNullable<
            ReturnType<typeof networkInterfaces>[string] | undefined
          >[number] => Boolean(entry && entry.family === 'IPv4' && !entry.internal)
        )
        .map((entry) => entry.address)
    ),
  ];

  for (const host of candidates) {
    try {
      const response = await fetch(`http://${host}:${port}/ping`);
      if (response.ok) {
        return host;
      }
    } catch {
      // Try the next interface
    }
  }

  return '127.0.0.1';
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
  const payload = connectResult.json as {
    daemon?: { pid?: number; socketPath?: string };
  };
  expect(payload?.daemon).toBeDefined();
  expect(typeof payload.daemon?.pid).toBe('number');
  expect(typeof payload.daemon?.socketPath).toBe('string');
}

async function cleanupSession(sessionName: string): Promise<void> {
  await runCLI(['close', '-s', sessionName]).catch(() => {});
  rmSync(join(SESSION_DIR, sessionName), { recursive: true, force: true });
  rmSync(join(SESSION_DIR, `${sessionName}.json`), { force: true });
}

function expectExecSuccess(result: Awaited<ReturnType<typeof runCLI>>) {
  expect(result.exitCode).toBe(0);
  const payload = result.json as {
    success?: boolean;
    steps: ExecStepJson[];
  };
  if (payload?.success !== true) {
    throw new Error(
      `Expected successful exec output.\nstdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`
    );
  }
  return payload;
}

function expectEvalResult(result: Awaited<ReturnType<typeof runCLI>>): unknown {
  expect(result.exitCode).toBe(0);
  const payload = result.json as { success?: boolean; result?: unknown };
  expect(payload.success).toBe(true);
  return payload.result;
}

function spawnCLI(args: string[]) {
  return Bun.spawn(['bun', './src/cli/index.ts', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
}

async function collectProcess(proc: ReturnType<typeof spawnCLI>) {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

function analyzeTraceWindow(tracePath: string) {
  const events = readFileSync(tracePath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event['channel'] === 'ws');

  const closeIndex = events.findIndex((event) => event['event'] === 'ws.connection.closed');
  const createIndex =
    closeIndex >= 0
      ? events.findIndex(
          (event, index) => index > closeIndex && event['event'] === 'ws.connection.created'
        )
      : -1;
  const between =
    closeIndex >= 0 && createIndex >= 0 ? events.slice(closeIndex + 1, createIndex) : [];
  const receivedBetweenCloseAndReconnect = between.filter(
    (event) => event['event'] === 'ws.frame.received'
  ).length;
  const receivedCount = events.filter((event) => event['event'] === 'ws.frame.received').length;

  return {
    closeIndex,
    createIndex,
    receivedBetweenCloseAndReconnect,
    receivedCount,
  };
}
