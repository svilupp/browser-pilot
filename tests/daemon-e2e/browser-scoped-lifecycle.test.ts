import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateSessionName, runCLI } from '../cli/setup.ts';
import { createAutoConnectHarness, destroyHarness } from '../utils/harness.ts';

describe('Packaged browser-scoped daemon lifecycle', () => {
  test('reuses, survives logical close, and performs one serialized crash recovery', async () => {
    const harness = await createAutoConnectHarness('beta');
    const firstSession = generateSessionName();
    const secondSession = generateSessionName();
    const thirdSession = generateSessionName();

    try {
      const first = await runCLI(['connect', '--name', firstSession, '--json'], {
        env: harness.discoveryEnv,
      });
      const second = await runCLI(['connect', '--name', secondSession, '--json'], {
        env: harness.discoveryEnv,
      });

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(second.json).toMatchObject({
        transport: 'daemon',
        daemon: {
          pid: (first.json as { daemon?: { pid?: number } }).daemon?.pid,
        },
      });

      const daemonPid = (first.json as { daemon?: { pid?: number } }).daemon?.pid;
      expect(typeof daemonPid).toBe('number');
      await runCLI(['close', '-s', firstSession], { env: harness.discoveryEnv });
      await runCLI(['close', '-s', secondSession], { env: harness.discoveryEnv });

      const afterLogicalClose = await runCLI(['daemon', 'list', '--json'], {
        env: harness.discoveryEnv,
      });
      expect(afterLogicalClose.json).toMatchObject({
        daemons: expect.arrayContaining([expect.objectContaining({ pid: daemonPid })]),
      });

      const third = await runCLI(['connect', '--name', thirdSession, '--json'], {
        env: harness.discoveryEnv,
      });
      expect(third.json).toMatchObject({ daemon: { pid: daemonPid } });

      const sessionPath = join(
        harness.homeDir!,
        '.browser-pilot',
        'sessions',
        `${thirdSession}.json`
      );
      const persisted = JSON.parse(await readFile(sessionPath, 'utf8')) as {
        daemon?: { cdpSessionId?: string };
      };
      expect(typeof persisted.daemon?.cdpSessionId).toBe('string');

      process.kill(daemonPid!, 'SIGKILL');
      await Bun.sleep(100);
      const concurrentRecovery = await Promise.all([
        runCLI(['page', '-s', thirdSession, '--json'], { env: harness.discoveryEnv }),
        runCLI(['page', '-s', thirdSession, '--json'], { env: harness.discoveryEnv }),
      ]);
      expect(concurrentRecovery.every((result) => result.exitCode === 0)).toBe(true);

      const recoveredStatus = await runCLI(['daemon', 'status', '-s', thirdSession, '--json'], {
        env: harness.discoveryEnv,
      });
      expect(recoveredStatus.json).toMatchObject({
        daemon: 'running',
        responsive: true,
      });
      expect((recoveredStatus.json as { pid?: number }).pid).not.toBe(daemonPid);

      const recoveredList = await runCLI(['daemon', 'list', '--json'], {
        env: harness.discoveryEnv,
      });
      const daemons = (recoveredList.json as { daemons?: Array<{ pid?: number }> }).daemons ?? [];
      expect(daemons).toHaveLength(1);
      expect(daemons[0]?.pid).toBe((recoveredStatus.json as { pid?: number }).pid);

      await runCLI(['daemon', 'stop', '-s', thirdSession], { env: harness.discoveryEnv });
    } finally {
      await runCLI(['close', '-s', firstSession], { env: harness.discoveryEnv }).catch(() => {});
      await runCLI(['close', '-s', secondSession], { env: harness.discoveryEnv }).catch(() => {});
      await runCLI(['close', '-s', thirdSession], { env: harness.discoveryEnv }).catch(() => {});
      await destroyHarness(harness);
    }
  }, 90000);
});
