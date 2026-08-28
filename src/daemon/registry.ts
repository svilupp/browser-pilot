/** Browser-scoped daemon registry.
 *
 * Logical browser-pilot sessions may point at the same daemon. The registry is
 * deliberately small and file based so it works in Bun, Node, and packaged
 * installs without another service. A descriptor is only a locator; PID and
 * socket liveness are checked by callers before reuse.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isRecord } from '../utils/json.ts';
import { isDaemonAlive } from './lifecycle.ts';

export const DAEMON_REGISTRY_DIR = join(homedir(), '.browser-pilot', 'daemons');
export const DAEMON_SESSION_DIR = join(homedir(), '.browser-pilot', 'sessions');

export interface DaemonDescriptor {
  schemaVersion: 1;
  id: string;
  connectionKey: string;
  endpointFingerprint: string;
  pid: number;
  socketPath: string;
  startedAt: string;
  heartbeatPath?: string;
}

export function daemonIdForConnection(connectionKey: string): string {
  return createHash('sha256').update(connectionKey).digest('hex').slice(0, 24);
}

export function endpointFingerprint(wsUrl: string): string {
  return createHash('sha256').update(wsUrl).digest('hex');
}

/** Build a stable browser-scoped key without persisting endpoint credentials. */
export function connectionKeyForBrowser(options: {
  provider: string;
  wsUrl: string;
  userDataDir?: string;
  legacyHost?: string;
  providerSessionId?: string;
}): string {
  if (options.userDataDir) {
    return `${options.provider}:profile:${resolve(options.userDataDir)}`;
  }
  if (options.provider !== 'generic' && options.providerSessionId) {
    return `${options.provider}:session:${options.providerSessionId}`;
  }
  if (options.legacyHost) {
    return `${options.provider}:host:${options.legacyHost.toLowerCase()}`;
  }
  return `${options.provider}:${endpointFingerprint(options.wsUrl)}`;
}

async function ensureRegistryDir(): Promise<void> {
  await fs.mkdir(DAEMON_REGISTRY_DIR, { recursive: true });
}

function descriptorPath(id: string): string {
  assertSafeDaemonId(id);
  return join(DAEMON_REGISTRY_DIR, `${id}.json`);
}

function lockPath(id: string): string {
  assertSafeDaemonId(id);
  return join(DAEMON_REGISTRY_DIR, `${id}.lock`);
}

function assertSafeDaemonId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error(`Invalid daemon id: ${id}`);
}

export async function readDaemonDescriptor(id: string): Promise<DaemonDescriptor | null> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(descriptorPath(id), 'utf8'));
    if (!isRecord(value) || value['schemaVersion'] !== 1) return null;
    if (
      typeof value['id'] !== 'string' ||
      typeof value['connectionKey'] !== 'string' ||
      typeof value['endpointFingerprint'] !== 'string' ||
      typeof value['pid'] !== 'number' ||
      typeof value['socketPath'] !== 'string' ||
      typeof value['startedAt'] !== 'string' ||
      value['id'] !== id ||
      (value['heartbeatPath'] !== undefined && typeof value['heartbeatPath'] !== 'string')
    ) {
      return null;
    }
    return value as unknown as DaemonDescriptor;
  } catch {
    return null;
  }
}

export async function findHealthyDaemon(connectionKey: string): Promise<DaemonDescriptor | null> {
  const id = daemonIdForConnection(connectionKey);
  const descriptor = await readDaemonDescriptor(id);
  if (!descriptor) return null;
  if (!isDaemonAlive(descriptor.pid)) return null;
  try {
    await fs.access(descriptor.socketPath);
  } catch {
    return null;
  }
  return descriptor;
}

export async function writeDaemonDescriptor(descriptor: DaemonDescriptor): Promise<void> {
  await ensureRegistryDir();
  const path = descriptorPath(descriptor.id);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, path);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

export async function removeDaemonDescriptor(id: string, expectedPid?: number): Promise<boolean> {
  if (expectedPid !== undefined) {
    const descriptor = await readDaemonDescriptor(id);
    if (!descriptor || descriptor.pid !== expectedPid) return false;
  }
  await fs.unlink(descriptorPath(id)).catch(() => {});
  return true;
}

/** Remove a descriptor only if it still belongs to the expected daemon. */
export async function removeOwnedDaemonDescriptor(
  id: string,
  expectedPid: number,
  lockTimeoutMs = 5000
): Promise<boolean> {
  const release = await acquireDaemonLock(id, lockTimeoutMs);
  try {
    return await removeDaemonDescriptor(id, expectedPid);
  } finally {
    await release();
  }
}

export async function listDaemonDescriptors(): Promise<DaemonDescriptor[]> {
  await ensureRegistryDir();
  const descriptors: DaemonDescriptor[] = [];
  for (const file of await fs.readdir(DAEMON_REGISTRY_DIR)) {
    if (!file.endsWith('.json')) continue;
    const descriptor = await readDaemonDescriptor(file.slice(0, -'.json'.length));
    if (descriptor) descriptors.push(descriptor);
  }
  return descriptors;
}

/** Remove abandoned registry locks without disturbing a live owner. */
export async function cleanStaleDaemonLocks(): Promise<string[]> {
  await ensureRegistryDir();
  const removed: string[] = [];
  for (const file of await fs.readdir(DAEMON_REGISTRY_DIR)) {
    if (!file.endsWith('.lock')) continue;
    const path = join(DAEMON_REGISTRY_DIR, file);
    try {
      const stat = await fs.stat(path);
      const raw = await fs.readFile(path, 'utf8');
      let ownerAlive = true;
      let ownerKnown = false;
      try {
        const owner: unknown = JSON.parse(raw);
        if (isRecord(owner) && typeof owner['pid'] === 'number') {
          ownerKnown = true;
          ownerAlive = isDaemonAlive(owner['pid']);
        }
      } catch {
        const legacyPid = Number.parseInt(raw.trim(), 10);
        if (Number.isFinite(legacyPid)) {
          ownerKnown = true;
          ownerAlive = isDaemonAlive(legacyPid);
        }
      }
      if (!ownerAlive || (!ownerKnown && Date.now() - stat.mtimeMs > 30_000)) {
        await fs.unlink(path);
        removed.push(file.slice(0, -'.lock'.length));
      }
    } catch {
      // A concurrent owner may have released the lock.
    }
  }
  return removed;
}

export async function countSessionReferences(
  daemonId: string,
  cdpSessionId?: string
): Promise<number> {
  let count = 0;
  try {
    const files = await fs.readdir(DAEMON_SESSION_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const value: unknown = JSON.parse(
          await fs.readFile(join(DAEMON_SESSION_DIR, file), 'utf8')
        );
        if (
          isRecord(value) &&
          isRecord(value['transport']) &&
          value['transport']['daemonId'] === daemonId &&
          (cdpSessionId === undefined ||
            (isRecord(value['daemon']) && value['daemon']['cdpSessionId'] === cdpSessionId))
        ) {
          count++;
        }
      } catch {
        // Ignore a session being atomically replaced or removed.
      }
    }
  } catch {
    return 0;
  }
  return count;
}

export async function acquireDaemonLock(
  id: string,
  timeoutMs = 5000
): Promise<() => Promise<void>> {
  await ensureRegistryDir();
  const path = lockPath(id);
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  for (;;) {
    try {
      const handle = await fs.open(path, 'wx');
      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token })}\n`,
          'utf8'
        );
        await handle.sync();
      } catch (error) {
        await fs.unlink(path).catch(() => {});
        throw error;
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          const lock: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
          if (isRecord(lock) && lock['token'] === token) await fs.unlink(path).catch(() => {});
        } catch {
          // The lock may already have been cleaned after a process failure.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(`Timed out acquiring daemon registry lock for ${id}`);
      }
      try {
        const stat = await fs.stat(path);
        const raw = await fs.readFile(path, 'utf8');
        let ownerAlive = true;
        let ownerKnown = false;
        try {
          const owner: unknown = JSON.parse(raw);
          if (isRecord(owner) && typeof owner['pid'] === 'number') {
            ownerKnown = true;
            ownerAlive = isDaemonAlive(owner['pid']);
          }
        } catch {
          const legacyPid = Number.parseInt(raw.trim(), 10);
          if (Number.isFinite(legacyPid)) {
            ownerKnown = true;
            ownerAlive = isDaemonAlive(legacyPid);
          }
        }
        if (
          !ownerAlive ||
          (!ownerKnown && Date.now() - stat.mtimeMs > Math.max(timeoutMs * 2, 30_000))
        ) {
          await fs.unlink(path).catch(() => {});
          continue;
        }
      } catch {
        // Another contender may have released the lock between stat/open.
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring daemon registry lock for ${id}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
