import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createOwnerActionService } from '../../src/core/owner-actions/executor.ts';
import type {
  OwnerActionContext,
  OwnerActionPolicy,
  OwnerActionReceipt,
  OwnerApproval,
  OwnerObservation,
  PreparedAction,
} from '../../src/core/owner-actions/types.ts';
import { TestContext } from './setup.ts';

const ctx = new TestContext();
describe('Owner typed backend in Chrome', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  async function fixture(evaluate?: OwnerActionPolicy['evaluate']) {
    const { page, baseUrl } = ctx.get();
    await page.goto(`${baseUrl}/basic.html`);
    await page.evaluate(() => {
      document.body.innerHTML =
        '<button id="open" onclick="this.dataset.clicked=String(Number(this.dataset.clicked||0)+1)">Open</button><input type="password" value="sensitive-canary"><div data-sensitive>sensitive-canary</div>';
    });
    const service = createOwnerActionService({
      policy: {
        id: 'fixture',
        version: '1',
        mode: 'enforce',
        allowedActions: ['click', 'fill', 'press'],
        redactText: (text) => text,
        evaluate,
      },
    });
    const context: OwnerActionContext = {
      grant: { ownerEpoch: 'epoch', grantId: crypto.randomUUID(), sequence: 1 },
      send: (method, params, sessionId) => page.cdpClient.send(method, params, sessionId ?? null),
    };
    const call = (method: string, params: unknown) =>
      service.dispatch(`owner.action.${method}`, params, context);
    const prepare = () =>
      call('prepare', {
        pageTargetId: page.targetId,
        action: { kind: 'click', selector: '#open' },
      }) as Promise<PreparedAction>;
    return {
      page,
      call,
      prepare,
      cleanup: () => service.revoke(context.grant.grantId, context.send),
    };
  }
  test('native retained-node click dispatches once with real typed observations', async () => {
    const f = await fixture();
    try {
      const observation = (await f.call('observe', {
        pageTargetId: f.page.targetId,
        kind: 'snapshot',
      })) as OwnerObservation;
      expect(observation.nodes?.some((node) => node.name === 'Open')).toBe(true);
      expect(JSON.stringify(observation)).not.toContain('sensitive-canary');
      const p = await f.prepare();
      expect(p.evidence.target).toBe('Open');
      const a = (await f.call('authorize', { preparedId: p.preparedId })) as OwnerApproval;
      const r = (await f.call('dispatch', { approvalId: a.approvalId })) as OwnerActionReceipt;
      expect(r.dispatchState).toBe('dispatched');
      expect(
        await f.page.evaluate(() => document.querySelector('#open')?.getAttribute('data-clicked'))
      ).toBe('1');
    } finally {
      await f.cleanup();
    }
  });
  test('same-document business context mutation during guard blocks every input', async () => {
    let mutate = async () => {};
    const f = await fixture(async () => {
      await mutate();
      return { verdict: 'allow', reason: 'fixture' };
    });
    mutate = () =>
      f.page.evaluate(() => {
        document.body.append(document.createTextNode('Changed order identity'));
      });
    try {
      const p = await f.prepare();
      const a = (await f.call('authorize', { preparedId: p.preparedId })) as OwnerApproval;
      expect(a.verdict).toBe('unknown');
      expect(a.reason).toBe('stale_evidence');
      expect(
        await f.page.evaluate(() => document.querySelector('#open')?.getAttribute('data-clicked'))
      ).toBeNull();
    } finally {
      await f.cleanup();
    }
  });
  test('replacement element after approval never receives click', async () => {
    const f = await fixture();
    try {
      const p = await f.prepare();
      const a = (await f.call('authorize', { preparedId: p.preparedId })) as OwnerApproval;
      await f.page.evaluate(() => {
        const node = document.querySelector('#open')!;
        node.replaceWith(node.cloneNode(true));
      });
      const r = (await f.call('dispatch', { approvalId: a.approvalId })) as OwnerActionReceipt;
      expect(r.dispatchState).toBe('not_dispatched');
      expect(r.reason).toBe('stale_evidence');
      expect(
        await f.page.evaluate(() => document.querySelector('#open')?.getAttribute('data-clicked'))
      ).toBeNull();
    } finally {
      await f.cleanup();
    }
  });
  test('covered target fails before approval and sends no input', async () => {
    const f = await fixture();
    try {
      await f.page.evaluate(() => {
        const cover = document.createElement('div');
        cover.id = 'cover';
        cover.style.cssText = 'position:fixed;inset:0;z-index:999999';
        document.body.append(cover);
      });
      const failure = await f.prepare().then(
        () => undefined,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(Error);
      expect(
        await f.page.evaluate(() => document.querySelector('#open')?.getAttribute('data-clicked'))
      ).toBeNull();
    } finally {
      await f.cleanup();
    }
  });
  test('finite extraction projects fresh rows and rejects secret value reads by default', async () => {
    const f = await fixture();
    try {
      await f.page.evaluate(() => {
        const table = document.createElement('div');
        table.id = 'rows';
        table.innerHTML =
          '<div class="row"><span class="price">125</span><span class="name">Product</span><input class="token" value="sensitive-canary"></div>';
        document.body.append(table);
      });
      const request = {
        pageTargetId: f.page.targetId,
        selector: '.row',
        maxRows: 10,
        fields: {
          price: { selector: '.price', source: 'text', type: 'number', required: true },
          name: { selector: '.name', source: 'text', type: 'string', required: true },
        },
      };
      const result = (await f.call('extract', request)) as { rows: unknown[] };
      expect(result.rows).toEqual([{ price: 125, name: 'Product' }]);
      await f.page.evaluate(() => {
        document.querySelector('.price')!.textContent = '150';
      });
      expect(((await f.call('extract', request)) as { rows: unknown[] }).rows).toEqual([
        { price: 150, name: 'Product' },
      ]);
      const failure = await f
        .call('extract', {
          ...request,
          fields: { token: { selector: '.token', source: 'value', type: 'string', secret: true } },
        })
        .then(
          () => undefined,
          (error: unknown) => error
        );
      expect(failure).toBeInstanceOf(Error);
    } finally {
      await f.cleanup();
    }
  });
  test('typed fill and focused Enter remain one owner transaction per action', async () => {
    const f = await fixture();
    try {
      await f.page.evaluate(() => {
        const input = document.createElement('input');
        input.id = 'query';
        input.value = 'old';
        input.onkeydown = (event) => {
          if (event.key === 'Enter') input.dataset['enter'] = 'yes';
        };
        document.body.append(input);
      });
      for (const action of [
        { kind: 'fill', selector: '#query', value: 'new' },
        { kind: 'press', selector: ':focus', key: 'Enter' },
      ]) {
        const p = (await f.call('prepare', {
          pageTargetId: f.page.targetId,
          action,
        })) as PreparedAction;
        const a = (await f.call('authorize', { preparedId: p.preparedId })) as OwnerApproval;
        const r = (await f.call('dispatch', { approvalId: a.approvalId })) as OwnerActionReceipt;
        expect(r.dispatchState).toBe('dispatched');
      }
      expect(
        await f.page.evaluate(() => (document.querySelector('#query') as HTMLInputElement).value)
      ).toBe('new');
      expect(
        await f.page.evaluate(() => document.querySelector('#query')?.getAttribute('data-enter'))
      ).toBe('yes');
    } finally {
      await f.cleanup();
    }
  });
  test('fill verification failure preserves dispatched receipt and never exposes value', async () => {
    const f = await fixture();
    try {
      await f.page.evaluate(() => {
        const input = document.createElement('input');
        input.id = 'query';
        input.oninput = () => {
          input.value = 'private-modified-canary';
        };
        document.body.append(input);
      });
      const p = (await f.call('prepare', {
        pageTargetId: f.page.targetId,
        action: { kind: 'fill', selector: '#query', value: 'requested', verify: 'exact' },
      })) as PreparedAction;
      const a = (await f.call('authorize', { preparedId: p.preparedId })) as OwnerApproval;
      const r = (await f.call('dispatch', { approvalId: a.approvalId })) as OwnerActionReceipt;
      expect(r.dispatchState).toBe('dispatched');
      expect(r.retrySafe).toBe(false);
      expect(r.reason).toBe('verification_failed');
      expect(JSON.stringify(r)).not.toContain('private-modified-canary');
    } finally {
      await f.cleanup();
    }
  });

  test('owner projections and evidence ignore hostile page-world DOM patches', async () => {
    const f = await fixture();
    try {
      await f.page.evaluate(() => {
        const query = Document.prototype.querySelectorAll;
        const bounds = Element.prototype.getBoundingClientRect;
        Document.prototype.querySelectorAll = () => {
          document.body.setAttribute('data-main-world-called', 'yes');
          throw new Error('Page-world query trap');
        };
        Element.prototype.getBoundingClientRect = () => {
          document.body.setAttribute('data-main-world-called', 'yes');
          throw new Error('Page-world geometry trap');
        };
        (globalThis as typeof globalThis & { ownerRestore?: () => void }).ownerRestore = () => {
          Document.prototype.querySelectorAll = query;
          Element.prototype.getBoundingClientRect = bounds;
        };
      });
      const observation = (await f.call('observe', {
        pageTargetId: f.page.targetId,
        kind: 'snapshot',
      })) as OwnerObservation;
      expect(observation.nodes?.some((node) => node.name === 'Open')).toBe(true);
      const p = await f.prepare();
      const a = (await f.call('authorize', { preparedId: p.preparedId })) as OwnerApproval;
      const r = (await f.call('dispatch', { approvalId: a.approvalId })) as OwnerActionReceipt;
      expect(r.dispatchState).toBe('dispatched');
      expect(
        await f.page.evaluate(() => document.body.getAttribute('data-main-world-called'))
      ).toBeNull();
    } finally {
      await f.page.evaluate(() => {
        (globalThis as typeof globalThis & { ownerRestore?: () => void }).ownerRestore?.();
      });
      await f.cleanup();
    }
  });
});
