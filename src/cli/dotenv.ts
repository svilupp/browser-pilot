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
}

/**
 * Load a dotenv file into `process.env`. Silently no-ops if the file is
 * missing or unreadable. Never prints values. By default, does not
 * override existing `process.env` values.
 */
export function loadDotenv(path = '.env', options: LoadDotenvOptions = {}): void {
  const { override = false } = options;

  if (typeof process === 'undefined' || !process.env) {
    return;
  }

  let content: string;
  try {
    if (!existsSync(path)) {
      return;
    }
    content = readFileSync(path, 'utf8');
  } catch {
    return;
  }

  const parsed = parseDotenv(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
