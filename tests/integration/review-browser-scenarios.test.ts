import { afterAll, beforeAll, expect, test } from 'bun:test';
import { getBrowserWebSocketUrl, type Page } from '../../src/index.ts';
import {
  type CrossOriginHarness,
  createCrossOriginHarness,
  destroyCrossOriginHarness,
} from '../utils/cross-origin-harness.ts';

let h: CrossOriginHarness;
beforeAll(async () => {
  h = await createCrossOriginHarness();
});
afterAll(async () => {
  if (h) await destroyCrossOriginHarness(h);
});

async function closeOwnedPage(page: Page): Promise<void> {
  await page.close();
  if (!page.cdpClient.isConnected) return;
  if (!(await h.browser.listTargets()).some((t) => t.targetId === page.targetId)) return;
  await page.cdpClient.send('Target.closeTarget', { targetId: page.targetId }, null);
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const targets = await h.browser.listTargets();
    if (!targets.some((t) => t.targetId === page.targetId)) return;
    await Bun.sleep(20);
  }
  throw new Error('Owned review target failed to disappear');
}

test('review nested OOPIF and delayed frame identity and isolation', async () => {
  const p = await h.browser.newPage(`${h.parentOrigin}/review-frame-parent.html`);
  try {
    await p.switchToFrame('#cross');
    expect(await p.text('#identity')).toBe('review child');
    await p.switchToFrame('#nested');
    expect(await p.evaluate<string>('document.querySelector("#identity").textContent')).toBe(
      'review leaf'
    );
    await p.fill('#value', 'leaf written');
    await p.switchToMain();
    expect(await p.evaluate<string>('document.querySelector("#value").value')).toBe(
      'parent original'
    );
    await p.switchToFrame('#late', { timeout: 3000 });
    expect(await p.text('#identity')).toBe('review child');
  } finally {
    await closeOwnedPage(p);
  }
}, 20000);

test('review detached same-origin selected evaluate must fail closed', async () => {
  const p = await h.browser.newPage(`${h.parentOrigin}/review-frame-parent.html`);
  try {
    await p.switchToFrame('#same');
    expect(await p.evaluate<string>('document.querySelector("#identity").textContent')).toBe(
      'review child'
    );
    await p.evaluate<unknown>('setTimeout(() => frameElement.remove(), 30); true');
    await Bun.sleep(150);
    await expect(
      p.evaluate<unknown>('document.querySelector("#value").value = "WRONG PARENT"')
    ).rejects.toThrow();
    await p.switchToMain();
    expect(await p.evaluate<string>('document.querySelector("#value").value')).toBe(
      'parent original'
    );
  } finally {
    await closeOwnedPage(p);
  }
}, 15000);

test('review storage reload history and simultaneous target isolation', async () => {
  const a = await h.browser.newPage(`${h.parentOrigin}/review-frame-leaf.html`);
  const b = await h.browser.newPage(`${h.parentOrigin}/review-frame-leaf.html`);
  try {
    await Promise.all([a.fill('#value', 'target A'), b.fill('#value', 'target B')]);
    expect(await a.evaluate<string>('document.querySelector("#value").value')).toBe('target A');
    expect(await b.evaluate<string>('document.querySelector("#value").value')).toBe('target B');
    await a.evaluate<unknown>(
      'localStorage.setItem("review", "shared");sessionStorage.setItem("review", "tab-a");document.cookie="review=shared;path=/";true'
    );
    expect(
      await b.evaluate<unknown>(
        '[localStorage.getItem("review"),sessionStorage.getItem("review"),document.cookie.includes("review=shared")]'
      )
    ).toEqual(['shared', null, true]);
    await a.evaluate<unknown>('history.pushState({}, "", "?spa=1");true');
    await a.reload({ timeout: 5000 });
    expect(
      await a.evaluate<unknown>('[localStorage.getItem("review"),sessionStorage.getItem("review")]')
    ).toEqual(['shared', 'tab-a']);
    await a.goto(`${h.parentOrigin}/review-frame-child.html`);
    await a.goBack({ timeout: 5000 });
    expect(await a.text('#identity')).toBe('review leaf');
    expect(await b.evaluate<string>('document.querySelector("#value").value')).toBe('target B');
  } finally {
    await closeOwnedPage(a);
    await closeOwnedPage(b);
  }
}, 20000);

test('review detached nested document within OOPIF fails closed and recovers explicitly', async () => {
  const p = await h.browser.newPage(`${h.parentOrigin}/review-frame-parent.html`);
  try {
    await p.switchToFrame('#cross');
    await p.switchToFrame('#nested');
    await p.evaluate<unknown>('setTimeout(() => frameElement.remove(), 30); true');
    await Bun.sleep(150);
    await expect(
      p.evaluate<unknown>('document.querySelector("#value").value = "WRONG CHILD"')
    ).rejects.toThrow();
    await expect(p.fill('#value', 'WRONG CHILD', { timeout: 500 })).rejects.toThrow();
    await p.switchToMain();
    await p.switchToFrame('#cross');
    expect(await p.evaluate<string>('document.querySelector("#value").value')).toBe(
      'child original'
    );
  } finally {
    await closeOwnedPage(p);
  }
}, 15000);

// Explicit diagnostic probes preserve Bun 1.3.10's compression failure without making the baseline red.
(process.env['BP_REVIEW_NATIVE_WS'] === '1' ? test : test.skip)(
  'review stale refs after SPA URL transition fail before changing input',
  async () => {
    const p = await h.browser.newPage(`${h.parentOrigin}/review-frame-leaf.html`);
    try {
      const snapshot = await p.snapshot();
      const ref = snapshot.interactiveElements.find((e) => e.role === 'textbox')?.ref;
      expect(ref).toBeDefined();
      await p.evaluate<unknown>('history.pushState({}, "", "?new-document-evidence=1");true');
      await expect(p.fill(`ref:${ref}`, 'wrong stale', { timeout: 500 })).rejects.toThrow();
      expect(await p.evaluate<string>('document.querySelector("#value").value')).toBe(
        'leaf original'
      );
    } finally {
      await closeOwnedPage(p);
    }
  },
  15000
);

(process.env['BP_REVIEW_NATIVE_WS'] === '1' ? test : test.skip)(
  'review slow DOM action stays within total action deadline',
  async () => {
    const p = await h.browser.newPage(`${h.parentOrigin}/review-frame-leaf.html`);
    try {
      await p.evaluate<unknown>(
        'const original = document.querySelector.bind(document);document.querySelector = function(...args){const start=Date.now();while(Date.now()-start<600){};return original(...args)};true'
      );
      const started = Date.now();
      await expect(p.fill('#value', 'late write', { timeout: 100 })).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(400);
      await Bun.sleep(650);
      expect(await p.evaluate<string>('document.querySelector("#value").value')).toBe(
        'leaf original'
      );
    } finally {
      await closeOwnedPage(p);
    }
  },
  15000
);

// This direct-source control needs Node's TypeScript transform support; older supported
// package runtimes are covered by the packed runtime matrix instead.
const nodeTypeTransformAvailable =
  Bun.spawnSync(['node', '--experimental-transform-types', '-e', ''], {
    stdout: 'ignore',
    stderr: 'ignore',
  }).exitCode === 0;
(nodeTypeTransformAvailable ? test : test.skip)(
  'review Node real ws control stale refs and deadline',
  async () => {
    const proc = Bun.spawn(
      [
        'node',
        '--experimental-transform-types',
        'tests/integration/review-node-control.mjs',
        await getBrowserWebSocketUrl(`localhost:${h.chrome.port}`),
        `${h.parentOrigin}/review-frame-leaf.html`,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const output = await new Response(proc.stdout).text();
    const error = await new Response(proc.stderr).text();
    expect(await proc.exited, `${output}\n${error}`).toBe(0);
    console.log(output.trim());
  },
  15000
);

test('review IndexedDB survives reload and separate targets; exact close removes only owned target', async () => {
  const a = await h.browser.newPage(`${h.parentOrigin}/review-frame-leaf.html`);
  const b = await h.browser.newPage(`${h.parentOrigin}/review-frame-leaf.html`);
  const read = `new Promise((resolve,reject)=>{const r=indexedDB.open('review-storage',1);r.onsuccess=()=>{const db=r.result;const g=db.transaction('values').objectStore('values').get('key');g.onsuccess=()=>{resolve(g.result);db.close()};g.onerror=()=>reject(g.error)};r.onerror=()=>reject(r.error)})`;
  try {
    await a.evaluate<unknown>(
      `new Promise((resolve,reject)=>{const r=indexedDB.open('review-storage',1);r.onupgradeneeded=()=>r.result.createObjectStore('values');r.onsuccess=()=>{const db=r.result;const tx=db.transaction('values','readwrite');tx.objectStore('values').put('persisted','key');tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error)};r.onerror=()=>reject(r.error)})`
    );
    expect(await b.evaluate<string>(read)).toBe('persisted');
    await a.reload({ timeout: 5000 });
    expect(await a.evaluate<string>(read)).toBe('persisted');
    const closedId = a.targetId;
    await h.browser.page('review-storage-owner', { targetId: closedId });
    await a.close();
    expect((await h.browser.listTargets()).some((t) => t.targetId === closedId)).toBe(true);
    await h.browser.closePage('review-storage-owner');
    const targets = await b.cdpClient.send<{ targetInfos: Array<{ targetId: string }> }>(
      'Target.getTargets',
      {},
      null
    );
    expect(targets.targetInfos.some((t) => t.targetId === closedId)).toBe(false);
    expect(targets.targetInfos.some((t) => t.targetId === b.targetId)).toBe(true);
    expect(await b.text('#identity')).toBe('review leaf');
  } finally {
    await closeOwnedPage(a);
    await closeOwnedPage(b);
  }
}, 20000);
