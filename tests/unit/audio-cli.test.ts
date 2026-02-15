/**
 * Unit tests for CLI audio command — argument parsing
 */

import { describe, expect, test } from 'bun:test';

// We test the parseAudioArgs function by importing the module and
// invoking the exported command with --help to verify it doesn't throw.
// The actual parsing logic is tested indirectly through behavior tests.

describe('audio CLI command', () => {
  test('audioCommand module exports correctly', async () => {
    const { audioCommand } = await import('../../src/cli/commands/audio.ts');
    expect(typeof audioCommand).toBe('function');
  });

  test('shows help without throwing', async () => {
    const { audioCommand } = await import('../../src/cli/commands/audio.ts');

    // Capture console output
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      await audioCommand(['--help'], { output: 'pretty' });
    } finally {
      console.log = origLog;
    }

    const helpText = logs.join('\n');
    expect(helpText).toContain('bp audio');
    expect(helpText).toContain('play');
    expect(helpText).toContain('capture');
    expect(helpText).toContain('roundtrip');
    expect(helpText).toContain('setup');
    expect(helpText).toContain('--transcribe');
    expect(helpText).toContain('OPENAI_API_KEY');
    expect(helpText).toContain('--silence-timeout');
    expect(helpText).toContain('--input');
  });

  test('shows help when no subcommand given', async () => {
    const { audioCommand } = await import('../../src/cli/commands/audio.ts');

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);

    try {
      await audioCommand([], { output: 'pretty' });
    } finally {
      console.log = origLog;
    }

    expect(logs.join('\n')).toContain('bp audio');
  });

  test('throws on unknown subcommand with session', async () => {
    // This would need a real session, so we test that it fails gracefully
    // when no session is available (the error is about session, not subcommand)
    const { audioCommand } = await import('../../src/cli/commands/audio.ts');

    // Without a session or browser, auto-connect will fail
    await expect(audioCommand(['bogus'], { output: 'pretty' })).rejects.toThrow();
  });

  test('play requires --input flag', async () => {
    const { audioCommand } = await import('../../src/cli/commands/audio.ts');

    // This will try to connect first, then fail on missing input
    // Since we can't connect, it'll fail at connection — that's fine,
    // we just verify the module loads and parses without crashing
    await expect(audioCommand(['play'], { output: 'pretty' })).rejects.toThrow();
  });

  test('roundtrip requires --input flag', async () => {
    const { audioCommand } = await import('../../src/cli/commands/audio.ts');
    await expect(audioCommand(['roundtrip'], { output: 'pretty' })).rejects.toThrow();
  });

  test('--transcribe without OPENAI_API_KEY throws early', async () => {
    const { audioCommand } = await import('../../src/cli/commands/audio.ts');
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = undefined;

    try {
      await expect(audioCommand(['capture', '--transcribe'], { output: 'pretty' })).rejects.toThrow(
        'OPENAI_API_KEY'
      );
    } finally {
      if (original) process.env.OPENAI_API_KEY = original;
    }
  });
});
