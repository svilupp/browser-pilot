import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOwnerActionDaemon } from '../../src/adapters/node/index.ts';
import { createCDPClientFromTransport } from '../../src/cdp/client.ts';
import type {
  OwnerActionReceipt,
  OwnerApproval,
  PreparedAction,
} from '../../src/core/owner-actions/types.ts';
import { createDaemonTransport } from '../../src/daemon/transport.ts';
import { TestContext } from './setup.ts';

const ctx = new TestContext();
describe('Strict owner action daemon in Chrome', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  test('fenced socket dispatches exact approved action; forgery/raw CDP/second controller fail', async () => {
    const { page, baseUrl } = ctx.get();
    await page.goto(`${baseUrl}/basic.html`);
    await page.evaluate(() => {
      document.body.innerHTML =
        '<button id="open" onclick="this.dataset.count=String(Number(this.dataset.count||0)+1)">Open</button>';
    });
    const directory = mkdtempSync(join(tmpdir(), 'bp-strict-owner-'));
    const path = join(directory, 'daemon.sock');
    const daemon = await startOwnerActionDaemon({
      socketPath: path,
      cdp: page.cdpClient,
      policy: {
        id: 'fixture',
        version: '1',
        mode: 'enforce',
        allowedActions: ['click'],
        redactText: (text) => text,
      },
    });
    const a = createCDPClientFromTransport(await createDaemonTransport(path));
    const b = createCDPClientFromTransport(await createDaemonTransport(path));
    try {
      await a.send('daemon.acquireLease');
      await expect(b.send('daemon.acquireLease')).rejects.toThrow('session_busy');
      await expect(
        a.send('Runtime.evaluate', { expression: 'document.body.click()' })
      ).rejects.toThrow('raw CDP');
      await expect(
        a.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10 })
      ).rejects.toThrow('raw CDP');
      await expect(a.send('owner.action.dispatch', { approvalId: 'forged' })).rejects.toThrow(
        'foreign owner handle'
      );
      const p = await a.send<PreparedAction>('owner.action.prepare', {
        pageTargetId: page.targetId,
        action: { kind: 'click', selector: '#open' },
      });
      const approval = await a.send<OwnerApproval>('owner.action.authorize', {
        preparedId: p.preparedId,
      });
      const receipt = await a.send<OwnerActionReceipt>('owner.action.dispatch', {
        approvalId: approval.approvalId,
      });
      expect(receipt.dispatchState).toBe('dispatched');
      expect(
        await page.evaluate(() => document.querySelector('#open')?.getAttribute('data-count'))
      ).toBe('1');
      await expect(
        a.send('owner.action.dispatch', { approvalId: approval.approvalId })
      ).rejects.toThrow();
      await a.send('daemon.releaseLease');
      await b.send('daemon.acquireLease');
      await expect(
        b.send('owner.action.authorize', { preparedId: p.preparedId })
      ).rejects.toThrow();
      await b.send('daemon.releaseLease');
    } finally {
      await a.close();
      await b.close();
      await daemon.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('model-latency mutation returns unknown across actual socket, never sends input', async () => {
    const { page, baseUrl } = ctx.get();
    await page.goto(`${baseUrl}/basic.html`);
    await page.evaluate(() => {
      document.body.innerHTML =
        '<button id="open" onclick="this.dataset.clicked=\'yes\'">Open</button>';
    });
    const directory = mkdtempSync(join(tmpdir(), 'bp-strict-model-'));
    const path = join(directory, 'daemon.sock');
    const daemon = await startOwnerActionDaemon({
      socketPath: path,
      cdp: page.cdpClient,
      policy: {
        id: 'fixture',
        version: '1',
        mode: 'enforce',
        allowedActions: ['click'],
        evaluate: async () => {
          await page.evaluate(() => {
            document.querySelector('#open')!.textContent = 'Refund';
          });
          return { verdict: 'allow', reason: 'fixture' };
        },
      },
    });
    const a = createCDPClientFromTransport(await createDaemonTransport(path));
    try {
      await a.send('daemon.acquireLease');
      const p = await a.send<PreparedAction>('owner.action.prepare', {
        pageTargetId: page.targetId,
        action: { kind: 'click', selector: '#open' },
      });
      const approval = await a.send<OwnerApproval>('owner.action.authorize', {
        preparedId: p.preparedId,
      });
      expect(approval).toEqual({ verdict: 'unknown', reason: 'stale_evidence' });
      expect(
        await page.evaluate(() => document.querySelector('#open')?.getAttribute('data-clicked'))
      ).toBeNull();
      await a.send('daemon.releaseLease');
    } finally {
      await a.close();
      await daemon.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
