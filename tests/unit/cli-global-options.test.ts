/**
 * Tests for global CLI option parsing. The global format flag is -f/--format.
 * The -o flag is NOT a global flag; it passes through to command-specific parsers
 * (e.g., audio's -o for output file).
 */

import { describe, expect, test } from 'bun:test';
import { parseAudioArgs } from '../../src/cli/commands/audio.ts';
import { parseGlobalOptions } from '../../src/cli/index.ts';

describe('parseGlobalOptions', () => {
  test('-f json is consumed as output format', () => {
    const { options, remaining } = parseGlobalOptions(['-f', 'json', 'roundtrip']);
    expect(options.format).toBe('json');
    expect(remaining).toEqual(['roundtrip']);
  });

  test('-f pretty is consumed as output format', () => {
    const { options, remaining } = parseGlobalOptions(['-f', 'pretty', 'roundtrip']);
    expect(options.format).toBe('pretty');
    expect(remaining).toEqual(['roundtrip']);
  });

  test('--format json is consumed as output format', () => {
    const { options, remaining } = parseGlobalOptions(['--format', 'json']);
    expect(options.format).toBe('json');
    expect(remaining).toEqual([]);
  });

  test('-o is not consumed as global flag (passes through to commands)', () => {
    const { options, remaining } = parseGlobalOptions([
      'roundtrip',
      '-i',
      'prompt.wav',
      '-o',
      'response.wav',
    ]);
    expect(options.format).toBe('pretty'); // default, -o is not a global flag
    expect(remaining).toContain('-o');
    expect(remaining).toContain('response.wav');
  });

  test('-o without next arg passes through', () => {
    const { options, remaining } = parseGlobalOptions(['-o']);
    expect(options.format).toBe('pretty');
    expect(remaining).toEqual(['-o']);
  });

  test('--json shorthand works', () => {
    const { options } = parseGlobalOptions(['--json', 'roundtrip']);
    expect(options.format).toBe('json');
  });

  test('-s flag is consumed as session', () => {
    const { options, remaining } = parseGlobalOptions(['-s', 'my-session', 'roundtrip']);
    expect(options.session).toBe('my-session');
    expect(remaining).toEqual(['roundtrip']);
  });
});

describe('global + audio arg pipeline', () => {
  test('-o response.wav reaches audio parser as out option', () => {
    // Simulate: bp audio roundtrip -i prompt.wav -o response.wav
    const cliArgs = ['roundtrip', '-i', 'prompt.wav', '-o', 'response.wav'];
    const { remaining } = parseGlobalOptions(cliArgs);

    // remaining should contain: roundtrip, -i, prompt.wav, -o, response.wav
    const audioOpts = parseAudioArgs(remaining);
    expect(audioOpts.subcommand).toBe('roundtrip');
    expect(audioOpts.input).toBe('prompt.wav');
    expect(audioOpts.out).toBe('response.wav');
  });

  test('-o response.wav with --transcribe and -s', () => {
    // Simulate: bp audio roundtrip -s my-session -i prompt.wav -o response.wav --transcribe
    const cliArgs = [
      '-s',
      'my-session',
      'roundtrip',
      '-i',
      'prompt.wav',
      '-o',
      'response.wav',
      '--transcribe',
    ];
    const { options, remaining } = parseGlobalOptions(cliArgs);

    expect(options.session).toBe('my-session');

    const audioOpts = parseAudioArgs(remaining);
    expect(audioOpts.subcommand).toBe('roundtrip');
    expect(audioOpts.input).toBe('prompt.wav');
    expect(audioOpts.out).toBe('response.wav');
    expect(audioOpts.doTranscribe).toBe(true);
  });

  test('-f json works as global format flag for audio commands', () => {
    // Simulate: bp audio check -f json
    const cliArgs = ['check', '-f', 'json'];
    const { options, remaining } = parseGlobalOptions(cliArgs);

    expect(options.format).toBe('json');

    const audioOpts = parseAudioArgs(remaining);
    expect(audioOpts.subcommand).toBe('check');
    expect(audioOpts.out).toBeUndefined();
  });

  test('--out long form works for audio output file', () => {
    const cliArgs = ['roundtrip', '-i', 'prompt.wav', '--out', 'response.wav'];
    const { remaining } = parseGlobalOptions(cliArgs);

    const audioOpts = parseAudioArgs(remaining);
    expect(audioOpts.out).toBe('response.wav');
  });

  test('capture with -o writes output file path', () => {
    const cliArgs = ['capture', '-o', 'captured.wav', '--duration', '5000'];
    const { remaining } = parseGlobalOptions(cliArgs);

    const audioOpts = parseAudioArgs(remaining);
    expect(audioOpts.subcommand).toBe('capture');
    expect(audioOpts.out).toBe('captured.wav');
    expect(audioOpts.duration).toBe(5000);
  });

  test('-o with .mp3 extension passes through to audio', () => {
    const cliArgs = ['roundtrip', '-i', 'input.wav', '-o', 'output.mp3'];
    const { options, remaining } = parseGlobalOptions(cliArgs);

    expect(options.format).toBe('pretty');
    const audioOpts = parseAudioArgs(remaining);
    expect(audioOpts.out).toBe('output.mp3');
  });

  test('-o with absolute path passes through to audio', () => {
    const cliArgs = ['roundtrip', '-i', 'input.wav', '-o', '/tmp/response.wav'];
    const { remaining } = parseGlobalOptions(cliArgs);

    const audioOpts = parseAudioArgs(remaining);
    expect(audioOpts.out).toBe('/tmp/response.wav');
  });
});
