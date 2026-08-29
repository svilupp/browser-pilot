import { describe, expect, test } from 'bun:test';
import { generateSessionName, runCLI } from '../cli/setup.ts';
import { createAutoConnectHarness, destroyHarness } from '../utils/harness.ts';

describe('Daemon target and trace control', () => {
  test('retargets exactly and runs a bounded background trace', async () => {
    const harness = await createAutoConnectHarness('beta');
    const sessionName = generateSessionName();

    try {
      const connected = await runCLI(
        [
          'connect',
          '--name',
          sessionName,
          '--new-tab',
          '--page-url',
          `${harness.baseUrl}/basic.html`,
          '--json',
        ],
        { env: harness.discoveryEnv }
      );
      expect(connected.exitCode).toBe(0);

      const initialTargets = await runCLI(['targets', '-s', sessionName, '--json'], {
        env: harness.discoveryEnv,
      });
      const original = (
        initialTargets.json as Array<{ targetId: string; current: boolean; url: string }>
      ).find((target) => target.current);
      expect(original?.url).toContain('/basic.html');

      const opened = await runCLI(
        [
          'exec',
          '-s',
          sessionName,
          '--json',
          JSON.stringify({ action: 'newTab', url: `${harness.baseUrl}/form.html` }),
        ],
        { env: harness.discoveryEnv }
      );
      const secondTargetId = (opened.json as { steps: Array<{ result: { targetId: string } }> })
        .steps[0]!.result.targetId;

      const switched = await runCLI(['use-target', '-s', sessionName, secondTargetId, '--json'], {
        env: harness.discoveryEnv,
      });
      expect(switched.exitCode).toBe(0);

      await runCLI(
        ['eval', '-s', sessionName, 'document.body.dataset.binding = "second"', '--json'],
        { env: harness.discoveryEnv }
      );
      await runCLI(['use-target', '-s', sessionName, original!.targetId, '--json'], {
        env: harness.discoveryEnv,
      });
      const originalMarker = await runCLI(
        ['eval', '-s', sessionName, 'document.body.dataset.binding || "first"', '--json'],
        { env: harness.discoveryEnv }
      );
      expect(originalMarker.json).toMatchObject({ result: 'first' });

      await runCLI(['use-target', '-s', sessionName, secondTargetId, '--json'], {
        env: harness.discoveryEnv,
      });
      const secondMarker = await runCLI(
        ['eval', '-s', sessionName, 'document.body.dataset.binding || "missing"', '--json'],
        { env: harness.discoveryEnv }
      );
      expect(secondMarker.json).toMatchObject({ result: 'second' });

      const listed = await runCLI(['targets', '-s', sessionName, '--json'], {
        env: harness.discoveryEnv,
      });
      const currentTargets = (listed.json as Array<{ targetId: string; current: boolean }>).filter(
        (target) => target.current
      );
      expect(currentTargets).toEqual([
        expect.objectContaining({ targetId: secondTargetId, current: true }),
      ]);

      const started = await runCLI(
        [
          'trace',
          'start',
          '-s',
          sessionName,
          '--background',
          '--timeout',
          '10000',
          '--max-mb',
          '1',
          '--json',
        ],
        { env: harness.discoveryEnv }
      );
      expect(started.exitCode).toBe(0);
      expect(started.json).toMatchObject({ active: true, status: 'running', maxMb: 1 });

      await runCLI(
        [
          'exec',
          '-s',
          sessionName,
          JSON.stringify({ action: 'goto', url: `${harness.baseUrl}/basic.html?trace=1` }),
        ],
        { env: harness.discoveryEnv }
      );
      const stopped = await runCLI(['trace', 'stop', '-s', sessionName, '--json'], {
        env: harness.discoveryEnv,
      });
      expect(stopped.exitCode).toBe(0);
      expect(stopped.json).toMatchObject({
        active: false,
        status: 'stopped',
        stopReason: 'requested',
      });
      expect((stopped.json as { events?: number }).events).toBeGreaterThan(0);

      const httpSummary = await runCLI(
        ['trace', 'summary', '-s', sessionName, '--view', 'http', '--json'],
        { env: harness.discoveryEnv }
      );
      expect(httpSummary.exitCode).toBe(0);
      const http = (
        httpSummary.json as {
          summary: {
            completed: number;
            requests: Array<{ durationMs: number | null; url: string | null }>;
          };
        }
      ).summary;
      expect(http.completed).toBeGreaterThan(0);
      expect(http.requests.some((request) => request.url?.includes('/basic.html?trace=1'))).toBe(
        true
      );
      expect(http.requests.some((request) => request.durationMs !== null)).toBe(true);

      const autoStarted = await runCLI(
        [
          'trace',
          'start',
          '-s',
          sessionName,
          '--background',
          '--timeout',
          '1000',
          '--max-mb',
          '1',
          '--json',
        ],
        { env: harness.discoveryEnv }
      );
      expect(autoStarted.json).toMatchObject({ active: true, status: 'running' });
      await Bun.sleep(1300);
      const autoStopped = await runCLI(['trace', 'status', '-s', sessionName, '--json'], {
        env: harness.discoveryEnv,
      });
      expect(autoStopped.json).toMatchObject({
        active: false,
        status: 'stopped',
        stopReason: 'timeout',
      });

      await runCLI(['daemon', 'stop', '-s', sessionName], { env: harness.discoveryEnv });
    } finally {
      await runCLI(['trace', 'stop', '-s', sessionName], { env: harness.discoveryEnv }).catch(
        () => {}
      );
      await runCLI(['close', '-s', sessionName], { env: harness.discoveryEnv }).catch(() => {});
      await destroyHarness(harness);
    }
  }, 90000);
});
