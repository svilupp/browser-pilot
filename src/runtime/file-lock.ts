import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { isRecord } from '../utils/json.ts';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Acquire an owner-checked file lock with bounded waiting. */
export async function acquireFileLock(
  path: string,
  timeoutMs = 5000
): Promise<() => Promise<void>> {
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
          const owner: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
          if (isRecord(owner) && owner['token'] === token) await fs.unlink(path).catch(() => {});
        } catch {
          // The owner or stale-lock cleanup may already have removed it.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const raw = await fs.readFile(path, 'utf8');
        const owner: unknown = JSON.parse(raw);
        if (isRecord(owner) && typeof owner['pid'] === 'number' && !isProcessAlive(owner['pid'])) {
          await fs.unlink(path).catch(() => {});
          continue;
        }
      } catch {
        // A process can die between exclusive creation and writing its owner
        // record. Keep a fresh unknown lock conservative, but eventually
        // remove it so one truncated file cannot wedge the session forever.
        try {
          const stat = await fs.stat(path);
          if (Date.now() - stat.mtimeMs > Math.max(timeoutMs * 2, 30_000)) {
            await fs.unlink(path).catch(() => {});
            continue;
          }
        } catch {
          // A concurrent owner may have released the lock.
        }
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring file lock: ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
