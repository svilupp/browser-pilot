import {
  createCrossOriginHarness,
  destroyCrossOriginHarness,
} from '../tests/utils/cross-origin-harness.ts';

const harness = await createCrossOriginHarness();
try {
  const child = Bun.spawn(
    [
      'node',
      'scripts/cross-consumer.mjs',
      harness.browser.wsUrl,
      harness.parentOrigin,
      harness.childOrigin,
    ],
    { stdout: 'inherit', stderr: 'inherit' }
  );
  const status = await child.exited;
  if (status !== 0) process.exitCode = status;
} finally {
  await destroyCrossOriginHarness(harness);
}
