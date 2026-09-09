/**
 * Minimal flag parser for the `bp` just-bash command.
 *
 * The native CLI parser (src/cli) pulls in Node-only modules, so the bridge
 * keeps its own dependency-free parser with the same conventions:
 * `--flag value` pairs, boolean switches, and positional arguments.
 */

import { usageError } from './types.ts';

export interface ArgSpec {
  /** Flags that take a value, e.g. `--out`. */
  flags?: string[];
  /** Boolean switches, e.g. `--full-page`. */
  switches?: string[];
}

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
  switches: Set<string>;
}

export function parseArgs(args: string[], spec: ArgSpec = {}): ParsedArgs {
  const flagNames = new Set(spec.flags ?? []);
  const switchNames = new Set(spec.switches ?? []);
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const switches = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (switchNames.has(arg)) {
      switches.add(arg);
      continue;
    }
    if (flagNames.has(arg)) {
      const value = args[++i];
      if (value === undefined) usageError(`${arg} requires a value. See bp --help.`);
      if (flags.has(arg)) usageError(`${arg} was supplied twice; provide it once.`);
      flags.set(arg, value);
      continue;
    }
    if (arg.startsWith('--') && arg !== '--') {
      usageError(`Unknown option '${arg}'. See bp --help.`);
    }
    positionals.push(arg);
  }

  return { positionals, flags, switches };
}

/** Parse a bounded non-negative integer flag value. */
export function intFlag(
  value: string | undefined,
  fallback: number,
  name: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    usageError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return Number(value);
}
