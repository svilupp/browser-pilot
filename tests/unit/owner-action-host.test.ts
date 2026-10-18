import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOwnerActionDaemon } from '../../src/adapters/node/owner-action-daemon.ts';
import type { CDPClient } from '../../src/cdp/client.ts';
import { createCDPClientFromTransport } from '../../src/cdp/client.ts';
import { endpointFingerprint } from '../../src/daemon/registry.ts';
import { createDaemonTransport } from '../../src/daemon/transport.ts';

test('trusted owner launcher computes canonical endpoint identity and rejects conflicting claims', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bp-owner-host-'));
  const socketPath = join(dir, 'owner.sock');
  const wsUrl = 'ws://127.0.0.1:1234/devtools/browser/fixture';
  const cdp = {
    send: async () => ({}),
    onAny() {},
    offAny() {},
    onTargetAttached: () => () => {},
  } as unknown as CDPClient;
  const policy = {
    id: 'fixture',
    version: '1',
    mode: 'enforce',
    allowedActions: ['click'],
  } as const;
  try {
    await expect(
      startOwnerActionDaemon({ socketPath, cdp, policy, wsUrl, endpointFingerprint: 'conflicting' })
    ).rejects.toThrow('identity conflicts');
    const owner = await startOwnerActionDaemon({ socketPath, cdp, policy, wsUrl });
    try {
      const control = createCDPClientFromTransport(await createDaemonTransport(socketPath));
      try {
        const hello = await control.send<{ endpointFingerprint: string }>('daemon.ping');
        expect(hello.endpointFingerprint).toBe(endpointFingerprint(wsUrl));
        expect(JSON.stringify(hello)).not.toContain(wsUrl);
      } finally {
        await control.close();
      }
    } finally {
      await owner.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
