/**
 * Unit tests for the portable provider factory (`src/providers/factory.ts`)
 * and the portable connection entry: credentials come only from explicit
 * options or an injected SecretsPort — never ambient env.
 */
import { describe, expect, test } from 'bun:test';
import { MemorySecrets } from '../../src/adapters/memory/index.ts';
import { connectCore } from '../../src/core/index.ts';
import { CapabilityError } from '../../src/core/ports.ts';
import { BrowserBaseProvider } from '../../src/providers/browserbase.ts';
import { createProvider } from '../../src/providers/factory.ts';
import { GenericProvider } from '../../src/providers/generic.ts';

describe('portable createProvider', () => {
  test('hosted provider without apiKey and without secrets port → CapabilityError("secrets")', () => {
    let caught: unknown;
    try {
      createProvider({ provider: 'browserbase' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CapabilityError);
    expect((caught as CapabilityError).capability).toBe('secrets');
    expect((caught as CapabilityError).message).toMatch(/BROWSERBASE_API_KEY/);
  });

  test('does not read ambient env even when the variable is set', () => {
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
      ?.env;
    if (!env) return;
    const previous = env['BROWSERBASE_API_KEY'];
    env['BROWSERBASE_API_KEY'] = 'ambient-key-should-be-ignored';
    try {
      expect(() => createProvider({ provider: 'browserbase' })).toThrow(CapabilityError);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(env, 'BROWSERBASE_API_KEY');
      else env['BROWSERBASE_API_KEY'] = previous;
    }
  });

  test('resolves the apiKey through an injected MemorySecrets port', () => {
    const secrets = new MemorySecrets({
      BROWSERBASE_API_KEY: 'secret-key',
      BROWSERBASE_PROJECT_ID: 'project-1',
    });
    const provider = createProvider({ provider: 'browserbase' }, { secrets });
    expect(provider).toBeInstanceOf(BrowserBaseProvider);
  });

  test('explicit apiKey wins and requires no secrets port', () => {
    const provider = createProvider({ provider: 'browserless', apiKey: 'explicit' });
    expect(provider.name).toBe('browserless');
  });

  test('generic provider needs only wsUrl', () => {
    const provider = createProvider({ provider: 'generic', wsUrl: 'ws://localhost:9222/x' });
    expect(provider).toBeInstanceOf(GenericProvider);
  });
});

describe('portable connect entry', () => {
  test('throws CapabilityError without local discovery or an explicit wsUrl/session', async () => {
    let caught: unknown;
    try {
      await connectCore({ provider: 'generic' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CapabilityError);
    expect((caught as CapabilityError).capability).toBe('local-discovery');
  });
});
