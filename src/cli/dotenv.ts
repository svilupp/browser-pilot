/**
 * Minimal .env loader for the Node CLI entrypoint.
 *
 * Bun auto-loads `.env` files, but the built `dist/cli.mjs` running under
 * Node does not. This is a tiny, dependency-free parser covering the
 * common dotenv syntax subset we need. It never overrides existing
 * `process.env` values unless `override: true` is passed, and it never
 * logs values.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parseDotenv } from './dotenv-parse.ts';

export interface LoadDotenvOptions {
  /** Override existing process.env values. Default: false. */
  override?: boolean;
  /**
   * Print a warning (never values) when the file can't be read. Intended for
   * an explicitly specified `--env-file`; the implicit default `.env` stays
   * silent. Default: false.
   */
  warnOnMissing?: boolean;
}

/**
 * Load a dotenv file into `process.env`. Silently no-ops if the file is
 * missing or unreadable (unless `warnOnMissing` is set). Never prints
 * values. By default, does not override existing `process.env` values.
 */
export function loadDotenv(path = '.env', options: LoadDotenvOptions = {}): void {
  const { override = false, warnOnMissing = false } = options;

  if (typeof process === 'undefined' || !process.env) {
    return;
  }

  let content: string;
  try {
    if (!existsSync(path)) {
      if (warnOnMissing) {
        console.error(`Warning: --env-file "${path}" does not exist; skipping.`);
      }
      return;
    }
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if (warnOnMissing) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Warning: --env-file "${path}" could not be read: ${message}`);
    }
    return;
  }

  const parsed = parseDotenv(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
