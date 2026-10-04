import { afterEach, describe, expect, test } from 'bun:test';
import { resolveWsHeaders } from '../../src/cli/ws-auth.ts';
import { clearEnvOverrides, setEnvOverrides } from '../../src/runtime/env.ts';

afterEach(clearEnvOverrides);
describe('WebSocket bearer environment references', () => {
  test('resolves a secret at connection time', () => {
    setEnvOverrides({ BP_TEST_WS_TOKEN: 'first' });
    expect(resolveWsHeaders('BP_TEST_WS_TOKEN')).toEqual({ Authorization: 'Bearer first' });
    setEnvOverrides({ BP_TEST_WS_TOKEN: 'rotated' });
    expect(resolveWsHeaders('BP_TEST_WS_TOKEN')).toEqual({ Authorization: 'Bearer rotated' });
  });
  test('rejects missing credentials and malformed env names without printing values', () => {
    setEnvOverrides({ BP_TEST_WS_TOKEN: undefined });
    expect(() => resolveWsHeaders('BP_TEST_WS_TOKEN')).toThrow('Missing WebSocket bearer token');
    expect(() => resolveWsHeaders('secret=literal')).toThrow('must name an environment variable');
    expect(resolveWsHeaders()).toBeUndefined();
  });
});
