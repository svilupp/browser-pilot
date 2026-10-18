import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('new typed borrower refuses an old daemon before acquire/browser dispatch (isolated modules)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bp-owner-protocol-home-'));
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL('../fixtures/named-owner-protocol.ts', import.meta.url)),
      ],
      { env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' }
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
