/**
 * Unit tests for multi-session (flat) CDP support in the client layer.
 *
 * Drives a fake in-memory Transport (no WebSocket, no browser) directly through
 * `createCDPClientFromTransport`, so we can inspect sent frames and inject
 * inbound events/responses. Covers session-aware event routing, the live
 * session registry, and the auto-attach / debugger-release helpers.
 */

import { describe, expect, test } from 'bun:test';
import { createCDPClientFromTransport } from '../../src/cdp/client.ts';
import type { Transport } from '../../src/cdp/transport.ts';

/** In-memory Transport double: records outbound frames, auto-replies to
 *  commands, and lets tests push inbound events. */
class FakeTransport implements Transport {
  sent: Array<Record<string, unknown>> = [];
  autoRespond = true;
  private messageHandlers: Array<(m: string) => void> = [];
  private closeHandlers: Array<() => void> = [];

  send(message: string): void {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    this.sent.push(parsed);
    if (this.autoRespond && typeof parsed['id'] === 'number') {
      const id = parsed['id'];
      queueMicrotask(() => this.emitRaw(JSON.stringify({ id, result: {} })));
    }
  }

  async close(): Promise<void> {
    for (const h of this.closeHandlers) h();
  }

  onMessage(handler: (m: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  onError(): void {}

  // --- test helpers ---

  emitRaw(raw: string): void {
    for (const h of this.messageHandlers) h(raw);
  }

  emitEvent(method: string, params?: Record<string, unknown>, sessionId?: string): void {
    const msg: Record<string, unknown> = { method };
    if (params !== undefined) msg['params'] = params;
    if (sessionId !== undefined) msg['sessionId'] = sessionId;
    this.emitRaw(JSON.stringify(msg));
  }

  lastSent(): Record<string, unknown> {
    const last = this.sent[this.sent.length - 1];
    if (!last) throw new Error('nothing sent');
    return last;
  }
}

function setup() {
  const transport = new FakeTransport();
  const client = createCDPClientFromTransport(transport);
  return { transport, client };
}

describe('session-aware event dispatch', () => {
  test('events route to the matching session handler and not to others', () => {
    const { transport, client } = setup();
    client.setSessionId('main');

    const childCalls: unknown[] = [];
    const mainCalls: unknown[] = [];

    const unsubChild = client.onSessionEvent('child', 'Runtime.executionContextCreated', (p) =>
      childCalls.push(p)
    );
    client.onSessionEvent('main', 'Runtime.executionContextCreated', (p) => mainCalls.push(p));

    // Event for the child session hits only the child handler.
    transport.emitEvent('Runtime.executionContextCreated', { context: { id: 1 } }, 'child');
    expect(childCalls).toHaveLength(1);
    expect(mainCalls).toHaveLength(0);

    // Event for the main session hits only the main handler.
    transport.emitEvent('Runtime.executionContextCreated', { context: { id: 2 } }, 'main');
    expect(mainCalls).toHaveLength(1);
    expect(childCalls).toHaveLength(1);

    // Unsubscribe stops further delivery.
    unsubChild();
    transport.emitEvent('Runtime.executionContextCreated', { context: { id: 3 } }, 'child');
    expect(childCalls).toHaveLength(1);
  });

  test('child-session events do NOT leak into legacy on() handlers', () => {
    const { transport, client } = setup();
    client.setSessionId('main');

    const legacyCalls: unknown[] = [];
    client.on('Runtime.executionContextCreated', (p) => legacyCalls.push(p));

    // Belongs to a non-default (child) session -> excluded from on().
    transport.emitEvent('Runtime.executionContextCreated', { context: { id: 1 } }, 'child');
    expect(legacyCalls).toHaveLength(0);

    // Belongs to the current default session -> delivered to on().
    transport.emitEvent('Runtime.executionContextCreated', { context: { id: 2 } }, 'main');
    expect(legacyCalls).toHaveLength(1);
  });

  test('events with no sessionId still reach legacy on() handlers', () => {
    const { transport, client } = setup();
    client.setSessionId('main');

    const legacyCalls: unknown[] = [];
    client.on('Page.loadEventFired', (p) => legacyCalls.push(p));

    // Browser-level event (no sessionId) always reaches on().
    transport.emitEvent('Page.loadEventFired', { timestamp: 1 });
    expect(legacyCalls).toHaveLength(1);
  });

  test('onAny firehose receives every event with its sessionId', () => {
    const { transport, client } = setup();
    const seen: Array<{ method: string; sessionId?: string }> = [];
    client.onAny((method, _params, sessionId) => seen.push({ method, sessionId }));

    transport.emitEvent('Foo.bar', {}, 'child');
    transport.emitEvent('Baz.qux', {});

    expect(seen).toEqual([
      { method: 'Foo.bar', sessionId: 'child' },
      { method: 'Baz.qux', sessionId: undefined },
    ]);
  });
});

describe('live session registry', () => {
  test('attachedToTarget / detachedFromTarget add and remove sessions', () => {
    const { transport, client } = setup();

    expect(client.hasSession('child1')).toBe(false);

    transport.emitEvent('Target.attachedToTarget', {
      sessionId: 'child1',
      targetInfo: { targetId: 't1', type: 'iframe', url: 'https://x.test', attached: true },
      waitingForDebugger: true,
    });

    expect(client.hasSession('child1')).toBe(true);
    expect([...client.sessions]).toContain('child1');

    transport.emitEvent('Target.detachedFromTarget', { sessionId: 'child1' });
    expect(client.hasSession('child1')).toBe(false);
    expect([...client.sessions]).not.toContain('child1');
  });

  test('onTargetAttached fires with the new session info', () => {
    const { transport, client } = setup();
    const attached: Array<{ sessionId: string; waitingForDebugger: boolean }> = [];
    const unsub = client.onTargetAttached((info) =>
      attached.push({ sessionId: info.sessionId, waitingForDebugger: info.waitingForDebugger })
    );

    transport.emitEvent('Target.attachedToTarget', {
      sessionId: 'child2',
      targetInfo: { targetId: 't2', type: 'iframe', url: 'https://y.test', attached: true },
      waitingForDebugger: true,
    });

    expect(attached).toEqual([{ sessionId: 'child2', waitingForDebugger: true }]);

    unsub();
    transport.emitEvent('Target.attachedToTarget', {
      sessionId: 'child3',
      targetInfo: { targetId: 't3', type: 'iframe', url: 'https://z.test', attached: true },
      waitingForDebugger: false,
    });
    expect(attached).toHaveLength(1);
  });

  test('attachToTarget populates the registry deterministically', async () => {
    const transport = new FakeTransport();
    transport.autoRespond = false;
    const client = createCDPClientFromTransport(transport);

    const attachPromise = client.attachToTarget('target-abc');
    // Reply to the Target.attachToTarget command with a session id.
    const req = transport.lastSent();
    expect(req['sessionId']).toBeUndefined();
    transport.emitRaw(JSON.stringify({ id: req['id'], result: { sessionId: 'sess-abc' } }));

    const sessionId = await attachPromise;
    expect(sessionId).toBe('sess-abc');
    expect(client.hasSession('sess-abc')).toBe(true);
    expect(client.sessionId).toBe('sess-abc');
  });
});

describe('auto-attach and debugger-release helpers', () => {
  test('setAutoAttach targets a specific session with the correct params', async () => {
    const { transport, client } = setup();

    await client.setAutoAttach({ sessionId: 'main' });

    const sent = transport.lastSent();
    expect(sent['method']).toBe('Target.setAutoAttach');
    expect(sent['sessionId']).toBe('main');
    expect(sent['params']).toEqual({
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: true,
    });
  });

  test('setAutoAttach defaults to the current default session', async () => {
    const { transport, client } = setup();
    client.setSessionId('default-sess');

    await client.setAutoAttach();

    const sent = transport.lastSent();
    expect(sent['method']).toBe('Target.setAutoAttach');
    expect(sent['sessionId']).toBe('default-sess');
  });

  test('setAutoAttach with sessionId:null targets browser-level (no sessionId)', async () => {
    const { transport, client } = setup();
    client.setSessionId('default-sess');

    await client.setAutoAttach({ sessionId: null });

    const sent = transport.lastSent();
    expect(sent['method']).toBe('Target.setAutoAttach');
    expect('sessionId' in sent).toBe(false);
  });

  test('runIfWaitingForDebugger sends to the given session with no params', async () => {
    const { transport, client } = setup();

    await client.runIfWaitingForDebugger('child-sess');

    const sent = transport.lastSent();
    expect(sent['method']).toBe('Runtime.runIfWaitingForDebugger');
    expect(sent['sessionId']).toBe('child-sess');
    expect('params' in sent).toBe(false);
  });
});
