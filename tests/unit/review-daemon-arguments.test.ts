import { describe, expect, test } from 'bun:test';
import { daemonCommand } from '../../src/cli/commands/daemon.ts';

describe('daemon owner argument admission', () => {
  test('rejects an extra positional owner before resolving the default session', async () => {
    await expect(daemonCommand(['stop', 'intended-owner'], {})).rejects.toThrow(
      'Unexpected daemon argument: intended-owner'
    );
  });

  test('rejects unknown switches instead of stopping the default owner', async () => {
    await expect(daemonCommand(['stop', '--deamon-id', 'intended-owner'], {})).rejects.toThrow(
      'Unexpected daemon argument: --deamon-id'
    );
  });

  test('does not consume another switch as the owner ID', async () => {
    await expect(daemonCommand(['stop', '--daemon-id', '--force'], {})).rejects.toThrow(
      '--daemon-id requires a value'
    );
  });

  test('rejects absent and malformed log counts', async () => {
    for (const value of [undefined, 'NaN', '0', '-1', '10trailing', '9007199254740992']) {
      const args = ['logs', '--lines', ...(value === undefined ? [] : [value])];
      await expect(daemonCommand(args, {})).rejects.toThrow('requires a positive integer');
    }
  });
});
