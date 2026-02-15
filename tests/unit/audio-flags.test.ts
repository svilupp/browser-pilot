/**
 * Unit tests for Chrome audio launch flags helper
 */

import { describe, expect, test } from 'bun:test';
import { getAudioChromeFlags } from '../../src/audio/flags.ts';

describe('getAudioChromeFlags', () => {
  test('returns base flags with no options', () => {
    const flags = getAudioChromeFlags();

    expect(flags).toContain('--use-fake-device-for-media-stream');
    expect(flags).toContain('--use-fake-ui-for-media-stream');
    expect(flags).toContain('--autoplay-policy=no-user-gesture-required');
    expect(flags.length).toBe(3);
  });

  test('adds fake audio capture flag with input path', () => {
    const flags = getAudioChromeFlags({
      inputWavPath: '/tmp/test.wav',
    });

    expect(flags).toContain('--use-file-for-fake-audio-capture=/tmp/test.wav');
    expect(flags.length).toBe(4);
  });

  test('adds %noloop suffix when noLoop is true', () => {
    const flags = getAudioChromeFlags({
      inputWavPath: '/tmp/test.wav',
      noLoop: true,
    });

    expect(flags).toContain('--use-file-for-fake-audio-capture=/tmp/test.wav%noloop');
  });

  test('does not add noloop when noLoop is false', () => {
    const flags = getAudioChromeFlags({
      inputWavPath: '/tmp/test.wav',
      noLoop: false,
    });

    expect(flags).toContain('--use-file-for-fake-audio-capture=/tmp/test.wav');
    expect(flags).not.toContain('--use-file-for-fake-audio-capture=/tmp/test.wav%noloop');
  });

  test('does not add capture flag when no inputWavPath', () => {
    const flags = getAudioChromeFlags({});

    const captureFlags = flags.filter((f) => f.includes('fake-audio-capture'));
    expect(captureFlags.length).toBe(0);
  });
});
