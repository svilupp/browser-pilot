import { expect, test } from 'bun:test';
import { createCDPClientFromTransport } from '../../src/cdp/client.ts';
import { attachSession } from '../../src/cli/attach.ts';
import { closeCommand } from '../../src/cli/commands/close.ts';
import { connectCommand } from '../../src/cli/commands/connect.ts';
import { deleteSession, loadSession, sessionExists } from '../../src/cli/session.ts';
import { stopDaemon } from '../../src/daemon/lifecycle.ts';
import { removeDaemonDescriptor } from '../../src/daemon/registry.ts';
import { createDaemonTransport } from '../../src/daemon/transport.ts';
import { BrowserBaseProvider } from '../../src/providers/browserbase.ts';
import { withEnv } from '../../src/runtime/env.ts';
import { createTestHarness, destroyHarness } from '../utils/harness.ts';

// Exercise the native CLI's cloud handshake followed by its real daemon.
// Only provider allocation/release are faked; Chrome and daemon IPC are real.
test('cloud CLI daemon keeps its bootstrap identity across repeated commands and close', async () => {
  const harness = await createTestHarness();
  const name = `test-cloud-daemon-${Date.now()}`;
  const originalCreate = BrowserBaseProvider.prototype.createSession;
  const originalRelease = BrowserBaseProvider.prototype.releaseSession;
  let pid: number | undefined;
  let daemonId: string | undefined;
  let allocations = 0;
  let releases = 0;
  try {
    const response = await fetch(`http://localhost:${harness.chrome.port}/json/version`);
    const endpoint = (await response.json()) as { webSocketDebuggerUrl: string };
    BrowserBaseProvider.prototype.createSession = async (options) => {
      expect(options?.['keepAlive']).toBe(true);
      allocations++;
      return {
        wsUrl: endpoint.webSocketDebuggerUrl,
        sessionId: 'scripted-remote',
        metadata: { projectId: 'scripted-project' },
        close: async () => ({ status: 'released', sessionId: 'scripted-remote' }),
      };
    };
    BrowserBaseProvider.prototype.releaseSession = async (sessionId) => {
      expect(sessionId).toBe('scripted-remote');
      releases++;
      return { status: 'released', sessionId };
    };
    await withEnv(
      {
        BROWSERBASE_API_KEY: 'synthetic-key',
        BROWSERBASE_PROJECT_ID: 'scripted-project',
        BROWSER_PILOT_NO_DAEMON: '',
      },
      async () => {
        await connectCommand(['--provider', 'browserbase', '--name', name], { format: 'json' });
        const session = await loadSession(name);
        pid = session.daemon?.pid;
        daemonId = session.transport?.mode === 'daemon' ? session.transport.daemonId : undefined;
        expect(daemonId).toBeDefined();
        expect(pid).toBeDefined();
        const cdp = createCDPClientFromTransport(
          await createDaemonTransport(session.daemon!.socketPath)
        );
        try {
          const ping = await cdp.send<{ daemonId?: string }>('daemon.ping', undefined, null);
          expect(ping.daemonId).toBe(daemonId);
        } finally {
          await cdp.close();
        }
        for (let i = 0; i < 2; i++) {
          const attached = await attachSession(await loadSession(name));
          try {
            expect(attached.viaDaemon).toBe(true);
            expect(attached.page.targetId).toBe(session.targetId!);
            if (i === 0) await attached.page.goto(`${harness.baseUrl}/basic.html`);
            expect(await attached.page.url()).toContain('/basic.html');
          } finally {
            await attached.browser.disconnect();
          }
        }
        expect(allocations).toBe(1);
        expect(releases).toBe(0);
        expect((await loadSession(name)).daemon?.pid).toBe(pid);
        await closeCommand([name], { format: 'json' });
        expect(releases).toBe(1);
        expect(await sessionExists(name)).toBe(false);
      }
    );
  } finally {
    BrowserBaseProvider.prototype.createSession = originalCreate;
    BrowserBaseProvider.prototype.releaseSession = originalRelease;
    // Only clean up the process and record allocated by this test.
    const leftover = await loadSession(name).catch(() => undefined);
    pid ??= leftover?.daemon?.pid;
    daemonId ??= leftover?.transport?.mode === 'daemon' ? leftover.transport.daemonId : undefined;
    if (pid) await stopDaemon(pid).catch(() => false);
    if (daemonId) await removeDaemonDescriptor(daemonId, pid);
    await deleteSession(name).catch(() => {});
    await destroyHarness(harness);
  }
}, 30_000);
