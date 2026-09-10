/**
 * Unit tests for the runtime env override layer.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  clearEnvOverrides,
  getEnv,
  requireEnv,
  setEnvOverrides,
  withEnv,
} from '../../src/runtime/env.ts';

const ENV_VAR = 'BROWSER_PILOT_TEST_VAR';

describe('runtime env overrides', () => {
  const originalValue = process.env[ENV_VAR];

  afterEach(() => {
    clearEnvOverrides();
    if (originalValue === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = originalValue;
    }
  });

  test('getEnv falls back to process.env when no override is set', () => {
    process.env[ENV_VAR] = 'from-process';
    expect(getEnv(ENV_VAR)).toBe('from-process');
  });

  test('overrides take precedence over process.env', () => {
    process.env[ENV_VAR] = 'from-process';
    setEnvOverrides({ [ENV_VAR]: 'from-override' });
    expect(getEnv(ENV_VAR)).toBe('from-override');
  });

  test('setEnvOverrides merges rather than replaces', () => {
    setEnvOverrides({ FOO_A: 'a' });
    setEnvOverrides({ FOO_B: 'b' });
    expect(getEnv('FOO_A')).toBe('a');
    expect(getEnv('FOO_B')).toBe('b');
  });

  test('clearEnvOverrides restores process.env-only lookups', () => {
    process.env[ENV_VAR] = 'from-process';
    setEnvOverrides({ [ENV_VAR]: 'from-override' });
    clearEnvOverrides();
    expect(getEnv(ENV_VAR)).toBe('from-process');
  });

  test('getEnv returns undefined for a missing variable', () => {
    expect(getEnv('BROWSER_PILOT_TEST_VAR_DOES_NOT_EXIST')).toBeUndefined();
  });

  test('requireEnv throws for a missing variable and succeeds once overridden', () => {
    expect(() => requireEnv('BROWSER_PILOT_TEST_VAR_MISSING')).toThrow();
    setEnvOverrides({ BROWSER_PILOT_TEST_VAR_MISSING: 'present' });
    expect(requireEnv('BROWSER_PILOT_TEST_VAR_MISSING')).toBe('present');
    clearEnvOverrides();
  });

  describe('withEnv scoping', () => {
    test('overrides apply only within the callback and restore afterward', async () => {
      setEnvOverrides({ [ENV_VAR]: 'outer' });

      const result = await withEnv({ [ENV_VAR]: 'inner' }, () => {
        expect(getEnv(ENV_VAR)).toBe('inner');
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(getEnv(ENV_VAR)).toBe('outer');
    });

    test('restores previous overrides even when the callback throws', async () => {
      setEnvOverrides({ [ENV_VAR]: 'outer' });

      await expect(
        withEnv({ [ENV_VAR]: 'inner' }, () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      expect(getEnv(ENV_VAR)).toBe('outer');
    });

    test('supports async callbacks', async () => {
      const result = await withEnv({ [ENV_VAR]: 'async-value' }, async () => {
        await Promise.resolve();
        return getEnv(ENV_VAR);
      });
      expect(result).toBe('async-value');
    });
  });

  describe('Workers-like environment (no globalThis.process)', () => {
    test('getEnv works from overrides alone when process is absent', () => {
      const realProcess = globalThis.process;
      // @ts-expect-error simulating a Worker runtime without process.env
      globalThis.process = undefined;

      try {
        setEnvOverrides({ [ENV_VAR]: 'worker-value' });
        expect(getEnv(ENV_VAR)).toBe('worker-value');
        expect(getEnv('BROWSER_PILOT_TEST_VAR_ABSENT')).toBeUndefined();
      } finally {
        globalThis.process = realProcess;
      }
    });
  });
});
