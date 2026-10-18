import { describe, expect, test } from 'bun:test';
import { createOwnerActionService } from '../../src/core/owner-actions/executor.ts';
import type {
  OwnerActionContext,
  OwnerActionPolicy,
  OwnerActionReceipt,
  OwnerApproval,
  PreparedAction,
} from '../../src/core/owner-actions/types.ts';

function fixture(policy: Partial<OwnerActionPolicy> = {}) {
  let html = '<button>Open</button>';
  let document = 1;
  let failInput = false;
  let rejectedBeforeSend = false;
  const inputs: string[] = [];
  const calls: string[] = [];
  const context: OwnerActionContext = {
    grant: { ownerEpoch: 'epoch', grantId: 'grant', sequence: 1 },
    async send(method, params) {
      calls.push(method);
      if (method === 'Page.getFrameTree')
        return { frameTree: { frame: { id: 'main', loaderId: `loader-${document}` } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 };
      if (method === 'Target.attachToTarget') return { sessionId: 'session' };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1, backendNodeId: document } };
      if (
        method === 'Runtime.evaluate' &&
        params?.['expression'] === 'document.documentElement.outerHTML'
      )
        return { result: { value: html } };
      if (method === 'Runtime.evaluate' && String(params?.['expression']).startsWith('(()=>'))
        return {
          result: {
            value: [
              {
                selector: 'html>button:nth-child(1)',
                role: 'button',
                name: 'Open',
                text: 'Open',
                visible: true,
                hit: true,
                enabled: true,
                boundingBox: { x: 1, y: 1, width: 20, height: 20 },
              },
            ],
          },
        };
      if (method === 'Runtime.evaluate')
        return {
          result: {
            value: JSON.stringify({
              url: 'https://example.com/?secret=canary',
              title: 'secret-canary',
              timeOrigin: 12,
            }),
          },
        };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [3] };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'node' } };
      if (method === 'Runtime.callFunctionOn')
        return {
          result: {
            value: JSON.stringify({
              connected: true,
              html,
              disabled: false,
              x: 1,
              y: 1,
              width: 20,
              height: 20,
              visible: true,
              hit: true,
              document: 12,
            }),
          },
        };
      if (method.startsWith('Input.') || method === 'DOM.focus' || method === 'Page.navigate') {
        inputs.push(method);
        if (rejectedBeforeSend)
          throw Object.assign(new Error('deadline before input'), {
            dispatchState: 'not_dispatched',
          });
        if (failInput) throw new Error('lost ACK');
      }
      return {};
    },
  };
  const service = createOwnerActionService({
    policy: {
      id: 'global',
      version: '1',
      mode: 'enforce',
      allowedActions: ['click', 'fill', 'press', 'goto', 'type', 'hover'],
      ...policy,
    },
  });
  const call = (method: string, params: unknown, ctx = context) =>
    service.dispatch(`owner.action.${method}`, params, ctx);
  const prepare = () =>
    call('prepare', {
      pageTargetId: 'page',
      action: { kind: 'click', selector: '#open' },
    }) as Promise<PreparedAction>;
  return {
    call,
    prepare,
    context,
    service,
    inputs,
    calls,
    mutate: () => {
      html = '<button>Refund</button>';
    },
    navigate: () => {
      document++;
    },
    rejectBeforeSend: () => {
      rejectedBeforeSend = true;
    },
    fail: () => {
      failInput = true;
    },
  };
}
describe('owner authoritative actions', () => {
  test('allows exact retained target once; no selector fallback after authorization', async () => {
    const f = fixture();
    const p = await f.prepare();
    const a = (await f.call('authorize', { preparedId: p.preparedId })) as OwnerApproval;
    expect(a.verdict).toBe('allow');
    const r = (await f.call('dispatch', { approvalId: a.approvalId })) as OwnerActionReceipt;
    expect(r.dispatchState).toBe('dispatched');
    expect(f.inputs).toHaveLength(3);
    await expect(f.call('dispatch', { approvalId: a.approvalId })).rejects.toThrow(
      'foreign owner handle'
    );
    expect(f.calls.filter((x) => x === 'DOM.querySelectorAll')).toHaveLength(1);
  });
  test('page changes during model latency deny before input', async () => {
    let change = () => {};
    const f = fixture({
      evaluate: async () => {
        change();
        return { verdict: 'allow', reason: 'yes' };
      },
    });
    change = f.mutate;
    const p = await f.prepare();
    const a = (await f.call('authorize', { preparedId: p.preparedId })) as OwnerApproval;
    expect(a).toEqual({ verdict: 'unknown', reason: 'stale_evidence' });
    expect(f.inputs).toHaveLength(0);
  });
  test('postapproval change and navigation stop dispatch', async () => {
    for (const operation of ['mutate', 'navigate'] as const) {
      const f = fixture();
      const p = await f.prepare();
      const a = (await f.call('authorize', { preparedId: p.preparedId })) as OwnerApproval;
      f[operation]();
      const r = (await f.call('dispatch', { approvalId: a.approvalId })) as OwnerActionReceipt;
      expect(r.dispatchState).toBe('not_dispatched');
      expect(r.reason).toBe('stale_evidence');
      expect(f.inputs).toHaveLength(0);
    }
  });
  test('foreign fence and forged approvals cannot dispatch', async () => {
    const f = fixture();
    const p = await f.prepare();
    await expect(
      f.call(
        'authorize',
        { preparedId: p.preparedId },
        { ...f.context, grant: { ...f.context.grant, grantId: 'foreign' } }
      )
    ).rejects.toThrow();
    await expect(f.call('dispatch', { approvalId: 'forged' })).rejects.toThrow();
    expect(f.inputs).toHaveLength(0);
  });
  test('unknown or unavailable guard fails closed; shadow logs but cannot weaken deterministic policy', async () => {
    const f = fixture({
      evaluate: async () => {
        throw new Error('unavailable');
      },
    });
    const p = await f.prepare();
    expect(await f.call('authorize', { preparedId: p.preparedId })).toEqual({
      verdict: 'unknown',
      reason: 'guard_unavailable',
    });
    const shadow = fixture({
      mode: 'shadow',
      allowedActions: ['goto'],
      evaluate: async () => ({ verdict: 'deny', reason: 'no' }),
    });
    await expect(shadow.prepare()).rejects.toThrow('forbidden');
    expect(shadow.inputs).toHaveLength(0);
  });
  test('postsend uncertainty produces nonretryable receipt and approval is consumed', async () => {
    const f = fixture();
    const p = await f.prepare();
    const a = (await f.call('authorize', { preparedId: p.preparedId })) as OwnerApproval;
    f.fail();
    const r = (await f.call('dispatch', { approvalId: a.approvalId })) as OwnerActionReceipt;
    expect(r.dispatchState).toBe('unknown');
    expect(r.retrySafe).toBe(false);
    expect(f.inputs).toHaveLength(1);
  });
  test('public evidence excludes secret payloads, page title and URL query', async () => {
    const f = fixture();
    const p = await f.call('prepare', {
      pageTargetId: 'page',
      action: { kind: 'fill', selector: '#password', value: 'secret-canary' },
    });
    expect(JSON.stringify(p)).not.toContain('canary');
    expect(JSON.stringify(p)).not.toContain('password');
  });
  test('strict profile rejects arbitrary scripts and raw method names', async () => {
    const f = fixture();
    expect(f.service.rawAllowed).toBe(false);
    await expect(
      f.call('observe', { pageTargetId: 'page', kind: 'evaluate', expression: 'mutate()' })
    ).rejects.toThrow('prohibited');
    await expect(f.service.dispatch('Runtime.evaluate', {}, f.context)).rejects.toThrow();
    expect(f.inputs).toHaveLength(0);
  });
  test('shadow classifier does not delay approval and its verdict cannot authorize forbidden action', async () => {
    let complete!: (result: { verdict: 'deny'; reason: string }) => void;
    let observed: unknown;
    const f = fixture({
      mode: 'shadow',
      evaluate: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      observe: (result) => {
        observed = result;
      },
    });
    const p = await f.prepare();
    const a = (await f.call('authorize', { preparedId: p.preparedId })) as OwnerApproval;
    expect(a.verdict).toBe('allow');
    expect(observed).toBeUndefined();
    complete({ verdict: 'deny', reason: 'shadow_only' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(observed).toEqual({ verdict: 'deny', reason: 'shadow_only' });
  });
  test('timeout cannot produce a late approval', async () => {
    const f = fixture({ timeoutMs: 1, evaluate: () => new Promise(() => {}) });
    const p = await f.prepare();
    expect(await f.call('authorize', { preparedId: p.preparedId })).toEqual({
      verdict: 'unknown',
      reason: 'guard_unavailable',
    });
    expect(f.inputs).toHaveLength(0);
  });
  test('navigation guard sees sanitized destination and trusted origin restriction', async () => {
    const f = fixture({ allowedNavigationOrigins: ['https://allowed.test'] });
    await expect(
      f.call('prepare', {
        pageTargetId: 'page',
        action: { kind: 'goto', url: 'https://forbidden.test/path' },
      })
    ).rejects.toThrow('Navigation forbidden');
    const p = (await f.call('prepare', {
      pageTargetId: 'page',
      action: { kind: 'goto', url: 'https://user:secret@allowed.test/path?token=canary#secret' },
    })) as PreparedAction;
    expect(p.evidence.destination).toBe('https://allowed.test/path');
    expect(JSON.stringify(p)).not.toContain('canary');
  });
  test('owner deadline rejection before first input preserves not_dispatched receipt', async () => {
    const f = fixture();
    const p = await f.prepare();
    const a = (await f.call('authorize', { preparedId: p.preparedId })) as OwnerApproval;
    f.rejectBeforeSend();
    const r = (await f.call('dispatch', { approvalId: a.approvalId })) as OwnerActionReceipt;
    expect(r.dispatchState).toBe('not_dispatched');
    expect(r.retrySafe).toBe(true);
    expect(r.inputEventsSent).toEqual([]);
  });
  test('navigation during typed projection cannot label fresh nodes with old document identity', async () => {
    const f = fixture();
    const send = f.context.send;
    f.context.send = async (method, params, sessionId) => {
      const value = await send(method, params, sessionId);
      if (method === 'Runtime.evaluate' && String(params?.['expression']).startsWith('(()=>'))
        f.navigate();
      return value;
    };
    await expect(f.call('observe', { pageTargetId: 'page', kind: 'snapshot' })).rejects.toThrow(
      'projection document changed'
    );
    expect(f.inputs).toHaveLength(0);
  });
});
