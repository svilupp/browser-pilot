import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotenv } from '../../src/cli/dotenv.ts';
import { parseDotenv } from '../../src/cli/dotenv-parse.ts';
import { extractEnvFileFlag } from '../../src/cli/index.ts';

describe('parseDotenv', () => {
  test('parses simple KEY=value pairs', () => {
    expect(parseDotenv('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  test('supports export KEY=value', () => {
    expect(parseDotenv('export FOO=bar')).toEqual({ FOO: 'bar' });
  });

  test('ignores full-line comments and blank lines', () => {
    expect(
      parseDotenv(`
        # a comment
        FOO=bar

        # another comment
        BAZ=qux
      `)
    ).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  test('handles single-quoted values literally (no escape processing)', () => {
    expect(parseDotenv(`FOO='hello\\nworld'`)).toEqual({ FOO: 'hello\\nworld' });
  });

  test('handles double-quoted values with \\n escapes', () => {
    expect(parseDotenv('FOO="hello\\nworld"')).toEqual({ FOO: 'hello\nworld' });
  });

  test('handles double-quoted values with escaped quotes and backslashes', () => {
    expect(parseDotenv('FOO="say \\"hi\\" \\\\ done"')).toEqual({ FOO: 'say "hi" \\ done' });
  });

  test('strips inline comments after unquoted values', () => {
    expect(parseDotenv('FOO=bar # this is a comment')).toEqual({ FOO: 'bar' });
  });

  test('does not strip a # inside a quoted value', () => {
    expect(parseDotenv('FOO="bar#baz"')).toEqual({ FOO: 'bar#baz' });
    expect(parseDotenv("FOO='bar#baz'")).toEqual({ FOO: 'bar#baz' });
  });

  test('parses quoted values followed by comments without changing credentials', () => {
    expect(parseDotenv('KEY="example_key" # Browserbase\nPROJECT=\'project\' # project')).toEqual({
      KEY: 'example_key',
      PROJECT: 'project',
    });
    expect(parseDotenv('KEY="value # inside" # outside')).toEqual({ KEY: 'value # inside' });
  });

  test('processes escaped backslashes once', () => {
    expect(parseDotenv(String.raw`KEY="literal\\n and \\r"`)).toEqual({
      KEY: String.raw`literal\n and \r`,
    });
  });

  test('ignores unterminated quotes and trailing non-comment text', () => {
    expect(parseDotenv('KEY="unterminated\nOTHER="value" trailing\nGOOD=ok')).toEqual({
      GOOD: 'ok',
    });
  });

  test('trims whitespace around unquoted values', () => {
    expect(parseDotenv('FOO=   bar   ')).toEqual({ FOO: 'bar' });
  });

  test('ignores malformed lines without an equals sign', () => {
    expect(parseDotenv('NOT_A_VAR\nFOO=bar')).toEqual({ FOO: 'bar' });
  });

  test('ignores keys that are not valid identifiers', () => {
    expect(parseDotenv('1FOO=bar\nGOOD_KEY=baz')).toEqual({ GOOD_KEY: 'baz' });
  });

  test('handles empty values', () => {
    expect(parseDotenv('FOO=')).toEqual({ FOO: '' });
  });
});

describe('loadDotenv', () => {
  let dir: string;
  const savedKeys = ['DOTENV_TEST_FOO', 'DOTENV_TEST_BAR', 'DOTENV_TEST_MISSING'];
  const originalValues: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'browser-pilot-dotenv-'));
    for (const key of savedKeys) {
      originalValues[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const key of savedKeys) {
      if (originalValues[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalValues[key];
      }
    }
  });

  test('loads variables from a file into process.env', () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'DOTENV_TEST_FOO=hello\nDOTENV_TEST_BAR=world\n');

    loadDotenv(file);

    expect(process.env['DOTENV_TEST_FOO']).toBe('hello');
    expect(process.env['DOTENV_TEST_BAR']).toBe('world');
  });

  test('does not override existing process.env values by default', () => {
    process.env['DOTENV_TEST_FOO'] = 'existing';
    const file = join(dir, '.env');
    writeFileSync(file, 'DOTENV_TEST_FOO=from-file\n');

    loadDotenv(file);

    expect(process.env['DOTENV_TEST_FOO']).toBe('existing');
  });

  test('overrides existing process.env values when override: true', () => {
    process.env['DOTENV_TEST_FOO'] = 'existing';
    const file = join(dir, '.env');
    writeFileSync(file, 'DOTENV_TEST_FOO=from-file\n');

    loadDotenv(file, { override: true });

    expect(process.env['DOTENV_TEST_FOO']).toBe('from-file');
  });

  test('silently no-ops when the file is missing', () => {
    const file = join(dir, 'does-not-exist.env');

    expect(() => loadDotenv(file)).not.toThrow();
    expect(process.env['DOTENV_TEST_MISSING']).toBeUndefined();
  });

  test('warns to stderr when warnOnMissing is set and the file is missing', () => {
    const file = join(dir, 'does-not-exist.env');
    const originalError = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      calls.push(args);
    };

    try {
      loadDotenv(file, { warnOnMissing: true });
    } finally {
      console.error = originalError;
    }

    expect(calls.length).toBe(1);
    expect(String(calls[0]?.[0])).toContain(file);
  });
});

describe('extractEnvFileFlag', () => {
  test('extracts a leading --env-file flag', () => {
    const result = extractEnvFileFlag(['--env-file', '.env.local', 'connect', '--name', 'dev']);
    expect(result.envFile).toBe('.env.local');
    expect(result.remaining).toEqual(['connect', '--name', 'dev']);
    expect(result.error).toBeUndefined();
  });

  test('defaults to .env when the flag is absent', () => {
    const result = extractEnvFileFlag(['connect', '--name', 'dev']);
    expect(result.envFile).toBe('.env');
    expect(result.remaining).toEqual(['connect', '--name', 'dev']);
  });

  test('does not consume --env-file appearing inside a subcommand payload', () => {
    const result = extractEnvFileFlag(['eval', '--env-file', 'not-a-path']);
    expect(result.envFile).toBe('.env');
    expect(result.remaining).toEqual(['eval', '--env-file', 'not-a-path']);
  });

  test('stops scanning at a `--` separator', () => {
    const result = extractEnvFileFlag(['--', 'exec', '--env-file', 'payload-arg']);
    expect(result.envFile).toBe('.env');
    expect(result.remaining).toEqual(['--', 'exec', '--env-file', 'payload-arg']);
  });

  test('errors on a dangling trailing --env-file with no path', () => {
    const result = extractEnvFileFlag(['--env-file']);
    expect(result.error).toBe('--env-file requires a file path argument');
  });
});
