import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { borrowOwnerActions } from '../../src/adapters/node/owner-actions.ts';
import {
  deleteSession,
  saveSession,
  updateSession,
  updateSessionTargetBinding,
} from '../../src/cli/session.ts';
import { endpointFingerprint } from '../../src/daemon/registry.ts';
import { decodeObject, jsonNumber, jsonString, parseJson } from '../../src/utils/json.ts';

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'bp-old-owner-'));
  const socketPath = join(dir, 'old.sock');
  const id = `protocol-${crypto.randomUUID()}`;
  const wsUrl = 'ws://127.0.0.1:1/devtools/browser/nonexistent';
  const methods: string[] = [];
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        const request = decodeObject(parseJson(line), { id: jsonNumber, method: jsonString });
        methods.push(request.method);
        socket.write(
          `${JSON.stringify({ id: request.id, result: { ok: true, endpointFingerprint: endpointFingerprint(wsUrl) } })}\n`
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await saveSession({
      id,
      provider: 'generic',
      wsUrl,
      targetId: 'existing',
      currentUrl: 'about:blank',
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      daemon: { socketPath, pid: process.pid, startedAt: new Date().toISOString() },
    });
    await assert.rejects(
      borrowOwnerActions({ session: id, targetPolicy: 'selected', recovery: 'never' }),
      /protocol version 2/
    );
    assert.deepEqual(methods, ['daemon.ping']);
    const changed = await updateSessionTargetBinding(id, {
      targetId: 'another',
      currentUrl: 'about:blank',
    });
    assert.equal(changed.metadata?.bindingRevision, 1);
    await assert.rejects(
      updateSessionTargetBinding(id, {
        targetId: 'existing',
        currentUrl: 'about:blank',
        expectedRevision: 0,
        expectedSocketPath: socketPath,
      }),
      /revision changed/
    );
    const cleared = await updateSession(id, { targetId: undefined });
    assert.equal(cleared.metadata?.bindingRevision, 2);
  } finally {
    await deleteSession(id, { preserveDaemonRuntime: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

await main();

// Profile negotiation must reject raw borrowing before Browser/Page initialization.
const { borrowNamedSession } = await import('../../src/adapters/node/named-session.ts');
const { startDaemonServer } = await import('../../src/daemon/server.ts');
const strictDir = await mkdtemp(join(tmpdir(), 'bp-strict-negotiation-'));
const strictSocket = join(strictDir, 'strict.sock');
const strictName = `strict-protocol-${crypto.randomUUID()}`;
const strictWs = 'ws://127.0.0.1:1/devtools/browser/strict-fixture';
let rawCalls = 0;
const fake = {
  async send() {
    rawCalls++;
    return {};
  },
  onAny() {},
  offAny() {},
  onTargetAttached: () => () => {},
} as unknown as import('../../src/cdp/client.ts').CDPClient;
const strictOwner = await startDaemonServer(strictSocket, fake, () => {}, undefined, {
  requireLease: true,
  endpointFingerprint: endpointFingerprint(strictWs),
  ownerActions: {
    rawAllowed: false,
    async revoke() {},
    async dispatch() {
      throw new Error('Unexpected typed action');
    },
  },
});
try {
  await saveSession({
    id: strictName,
    provider: 'generic',
    wsUrl: strictWs,
    targetId: 'existing',
    currentUrl: 'about:blank',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    daemon: { socketPath: strictSocket, pid: process.pid, startedAt: new Date().toISOString() },
  });
  await assert.rejects(
    borrowNamedSession({ session: strictName, targetPolicy: 'selected' }),
    /strict action profile/
  );
  assert.equal(rawCalls, 0);
} finally {
  await deleteSession(strictName, { preserveDaemonRuntime: true });
  await strictOwner.close();
  await rm(strictDir, { recursive: true, force: true });
}

// Legacy metadata must not activate attachSession's ordinary direct fallback.
const unavailableDir = await mkdtemp(join(tmpdir(), 'bp-borrow-no-fallback-'));
const unavailableName = `no-fallback-${crypto.randomUUID()}`;
let newConnections = 0;
const endpoint = Bun.serve({
  port: 0,
  fetch(request, server) {
    newConnections++;
    if (server.upgrade(request)) return;
    return new Response('no');
  },
  websocket: { message() {} },
});
try {
  await saveSession({
    id: unavailableName,
    provider: 'generic',
    wsUrl: `ws://127.0.0.1:${endpoint.port}`,
    targetId: 'existing',
    currentUrl: 'about:blank',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    daemon: {
      socketPath: join(unavailableDir, 'missing.sock'),
      pid: process.pid,
      startedAt: new Date().toISOString(),
    },
  });
  await assert.rejects(
    borrowNamedSession({ session: unavailableName, targetPolicy: 'selected', recovery: 'never' }),
    /unavailable/
  );
  assert.equal(newConnections, 0);
} finally {
  await deleteSession(unavailableName, { preserveDaemonRuntime: true });
  endpoint.stop(true);
  await rm(unavailableDir, { recursive: true, force: true });
}
