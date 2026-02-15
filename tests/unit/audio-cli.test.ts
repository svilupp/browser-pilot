import { describe, expect, test } from 'bun:test';

async function runBP(
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['bun', 'run', 'src/cli/index.ts', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe('audio CLI command', () => {
  test('shows help with subcommands and options', async () => {
    const { stdout, exitCode } = await runBP(['audio', '--help']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('roundtrip');
    expect(stdout).toContain('play');
    expect(stdout).toContain('capture');
    expect(stdout).toContain('setup');
    expect(stdout).toContain('--transcribe');
    expect(stdout).toContain('--silence-timeout');
    expect(stdout).toContain('--input');
    expect(stdout).toContain('OPENAI_API_KEY');
  });

  test('shows help when no subcommand given', async () => {
    const { stdout, exitCode } = await runBP(['audio']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('bp audio');
  });

  test('--transcribe without OPENAI_API_KEY throws with clear message', async () => {
    const env = { ...process.env };
    env['OPENAI_API_KEY'] = '';

    const proc = Bun.spawn(['bun', 'run', 'src/cli/index.ts', 'audio', 'capture', '--transcribe'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('OPENAI_API_KEY');
  });
});
