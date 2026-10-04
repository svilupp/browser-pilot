import assert from 'node:assert/strict';
import { createNodeTransportFactory } from '../../src/adapters/node/transport.ts';
import { connect } from '../../src/index.ts';

const browser = await connect({
  provider: 'generic',
  wsUrl: process.argv[2],
  transportFactory: await createNodeTransportFactory(),
});
try {
  const p = await browser.newPage(process.argv[3]);
  const s = await p.snapshot();
  const ref = s.interactiveElements.find((e) => e.role === 'textbox').ref;
  await p.evaluate('history.pushState({},"","?spa=1");true');
  await assert.rejects(p.fill(`ref:${ref}`, 'wrong stale', { timeout: 500 }));
  assert.equal(await p.evaluate('document.querySelector("#value").value'), 'leaf original');
  await p.evaluate(
    'const original=document.querySelector.bind(document);document.querySelector=function(...args){const start=Date.now();while(Date.now()-start<600){};return original(...args)};true'
  );
  const start = Date.now();
  await assert.rejects(p.fill('#value', 'late write', { timeout: 100 }));
  assert.ok(Date.now() - start < 400);
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(await p.evaluate('document.querySelector("#value").value'), 'leaf original');
  await p.close();
  await p.cdpClient.send('Target.closeTarget', { targetId: p.targetId }, null);
  const deadline = Date.now() + 1000;
  let exists = true;
  while (exists && Date.now() < deadline) {
    exists = (await browser.listTargets()).some((t) => t.targetId === p.targetId);
    if (exists) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(exists, false, 'Owned target must disappear after close');
  console.log('NODE CONTROL PASS stale-ref and slow-action deadline');
} finally {
  await browser.close();
}
