/**
 * Unit tests for createProvider's env-var fallback wiring.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BrowserBaseProvider } from '../../src/providers/browserbase.ts';
import { BrowserlessProvider } from '../../src/providers/browserless.ts';
import { createProvider } from '../../src/providers/index.ts';
import { clearEnvOverrides, setEnvOverrides } from '../../src/runtime/env.ts';

describe('createProvider', () => {
  beforeEach(() => {
    // Shadow any real credentials present in the ambient process.env (e.g. a
    // developer .env) so these tests deterministically exercise the
    // missing/present cases regardless of the host environment.
    setEnvOverrides({
      BROWSERBASE_API_KEY: undefined,
      BROWSERBASE_PROJECT_ID: undefined,
      BROWSERLESS_API_KEY: undefined,
    });
  });

  afterEach(() => {
    clearEnvOverrides();
  });

  describe('browserbase', () => {
    test('falls back to BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID env vars', () => {
      setEnvOverrides({
        BROWSERBASE_API_KEY: 'env-api-key',
        BROWSERBASE_PROJECT_ID: 'env-project-id',
      });

      const provider = createProvider({ provider: 'browserbase' });
      expect(provider).toBeInstanceOf(BrowserBaseProvider);
    });

    test('explicit apiKey wins over the env var', () => {
      setEnvOverrides({ BROWSERBASE_API_KEY: 'env-api-key' });

      // Should not throw even though env has a value too — explicit wins.
      expect(() =>
        createProvider({ provider: 'browserbase', apiKey: 'explicit-api-key' })
      ).not.toThrow();
    });

    test('projectId is not required', () => {
      setEnvOverrides({ BROWSERBASE_API_KEY: 'env-api-key' });
      expect(() => createProvider({ provider: 'browserbase' })).not.toThrow();
    });

    test('throws an actionable error mentioning BROWSERBASE_API_KEY when apiKey is missing', () => {
      expect(() => createProvider({ provider: 'browserbase' })).toThrow(/BROWSERBASE_API_KEY/);
    });
  });

  describe('browserless', () => {
    test('falls back to BROWSERLESS_API_KEY env var', () => {
      setEnvOverrides({ BROWSERLESS_API_KEY: 'env-token' });
      const provider = createProvider({ provider: 'browserless' });
      expect(provider).toBeInstanceOf(BrowserlessProvider);
    });

    test('explicit apiKey wins over the env var', () => {
      setEnvOverrides({ BROWSERLESS_API_KEY: 'env-token' });
      expect(() =>
        createProvider({ provider: 'browserless', apiKey: 'explicit-token' })
      ).not.toThrow();
    });

    test('throws when neither apiKey nor env var is set', () => {
      expect(() => createProvider({ provider: 'browserless' })).toThrow(/BROWSERLESS_API_KEY/);
    });
  });
});
