/**
 * Chrome launch flags for audio automation.
 *
 * Use these when launching Chrome yourself (not connecting to a remote browser).
 * These provide a complementary path to the JS injection approach — they
 * configure Chrome's built-in fake device support at launch time.
 */

export interface AudioFlagOptions {
  /** Path to WAV file for fake microphone input */
  inputWavPath?: string;
  /** Disable looping of the input file (play once) */
  noLoop?: boolean;
}

/**
 * Get Chrome flags needed for audio automation.
 *
 * @example
 * ```typescript
 * import { getAudioChromeFlags } from 'browser-pilot';
 *
 * const flags = getAudioChromeFlags({
 *   inputWavPath: '/tmp/prompt.wav',
 * });
 * // Pass to chrome-launcher or similar
 * ```
 */
export function getAudioChromeFlags(options?: AudioFlagOptions): string[] {
  const flags = [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ];

  if (options?.inputWavPath) {
    let path = options.inputWavPath;
    if (options.noLoop) {
      path += '%noloop';
    }
    flags.push(`--use-file-for-fake-audio-capture=${path}`);
  }

  return flags;
}
