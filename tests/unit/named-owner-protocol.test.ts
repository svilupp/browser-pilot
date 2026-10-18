import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

test('new typed borrower refuses an old daemon before acquire/browser dispatch (isolated modules)', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL('../fixtures/named-owner-protocol.ts', import.meta.url)),
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exitCode, stderr).toBe(0);
});
