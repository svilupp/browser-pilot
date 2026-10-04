import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

describe('Native keyboard behavior through maintained Node transport', () => {
  test('Enter submits forms and inserts textarea newlines without breaking modifiers', async () => {
    const child = Bun.spawn(
      [
        'node',
        '--experimental-transform-types',
        join(import.meta.dir, 'keyboard-native-submit.mjs'),
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain('Native Enter form submission');
  }, 30000);
});
