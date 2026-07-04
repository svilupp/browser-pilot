/**
 * Unit tests for the session-scoped CDP view (createSessionScopedCDP).
 *
 * Drives the real client over an in-memory Transport (no WebSocket, no browser)
 * so we can assert the exact sessionId placed on outbound frames and how inbound
 * events are routed to a pinned view. This is the core of the multi-target
 * isolation fix: a scoped view must stay on ITS OWN session even after the
 * client's mutable "current default session" moves to a later-attached target.
 */

import { describe, expect, test } from 'bun:test';
import { createCDPClientFromTransport } from '../../src/cdp/client.ts';
import { createSessionScopedCDP } from '../../src/cdp/session-scope.ts';
import type { Transport } from '../../src/cdp/transport.ts';

class FakeTransport implements Transport {
  sent: Array<Record<string, unknown>> = [];
  private messageHandlers: Array<(m: string) => void> = [];
  private closeHandlers: Array<() => void> = [];

  send(message: string): void {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    this.sent.push(parsed);
    if (typeof parsed['id'] === 'number') {
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

describe('createSessionScopedCDP - send routing', () => {
  test('omitted sessionId targets the pinned session (not the mutable default)', async () => {
    const { transport, client } = setup();
    const scoped = createSessionScopedCDP(client, 'page-a');

    // Simulate another target attaching later: this moves the client's default.
    client.setSessionId('page-b');

    await scoped.send('DOM.getDocument');
    expect(transport.lastSent()['sessionId']).toBe('page-a');
  });

  test('explicit child sessionId (OOPIF) passes through unchanged', async () => {
    const { transport, client } = setup();
    const scoped = createSessionScopedCDP(client, 'page-a');

    await scoped.send('DOM.focus', { nodeId: 1 }, 'child-frame');
    expect(transport.lastSent()['sessionId']).toBe('child-frame');
  });

  test('explicit null targets browser-level (no sessionId on the frame)', async () => {
    const { transport, client } = setup();
    const scoped = createSessionScopedCDP(client, 'page-a');

    await scoped.send('Target.getTargets', undefined, null);
    expect('sessionId' in transport.lastSent()).toBe(false);
  });

  test('sessionId getter reflects the pinned session', () => {
    const { client } = setup();
    client.setSessionId('page-b');
    const scoped = createSessionScopedCDP(client, 'page-a');
    expect(scoped.sessionId).toBe('page-a');
  });
});

describe('createSessionScopedCDP - setAutoAttach pinning', () => {
  test('omitted sessionId arms auto-attach on the pinned session (not the mutable default)', async () => {
    const { transport, client } = setup();
    const scoped = createSessionScopedCDP(client, 'page-a');

    // Another target attached later moves the client's mutable default.
    client.setSessionId('page-b');

    await scoped.setAutoAttach();
    const sent = transport.lastSent();
    expect(sent['method']).toBe('Target.setAutoAttach');
    expect(sent['sessionId']).toBe('page-a');
  });

  test('explicit child sessionId (nested OOPIF) passes through unchanged', async () => {
    const { transport, client } = setup();
    const scoped = createSessionScopedCDP(client, 'page-a');

    await scoped.setAutoAttach({ sessionId: 'child-frame' });
    expect(transport.lastSent()['sessionId']).toBe('child-frame');
  });

  test('explicit null targets browser-level (no sessionId on the frame)', async () => {
    const { transport, client } = setup();
    const scoped = createSessionScopedCDP(client, 'page-a');

    await scoped.setAutoAttach({ sessionId: null });
    expect('sessionId' in transport.lastSent()).toBe(false);
  });
});

describe('createSessionScopedCDP - setSessionId guard', () => {
  test('setSessionId throws on a scoped view to protect sibling views', () => {
    const { client } = setup();
    const scoped = createSessionScopedCDP(client, 'page-a');

    expect(() => scoped.setSessionId('page-b')).toThrow(/session-scoped CDP view/);
  });

  test('throwing setSessionId does not mutate the underlying client default', () => {
    const { client } = setup();
    client.setSessionId('page-b');
    const scoped = createSessionScopedCDP(client, 'page-a');

    expect(() => scoped.setSessionId('page-c')).toThrow();
    expect(client.sessionId).toBe('page-b');
  });
});

describe('createSessionScopedCDP - event routing', () => {
  test('on() fires for pinned-session events and browser-level events only', () => {
    const { transport, client } = setup();
    const scoped = createSessionScopedCDP(client, 'page-a');

    const calls: unknown[] = [];
    scoped.on('Page.loadEventFired', (p) => calls.push(p));

    // Pinned session -> delivered.
    transport.emitEvent('Page.loadEventFired', { n: 1 }, 'page-a');
    // Browser-level (no sessionId) -> delivered.
    transport.emitEvent('Page.loadEventFired', { n: 2 });
    // A different session -> NOT delivered.
    transport.emitEvent('Page.loadEventFired', { n: 3 }, 'page-b');

    expect(calls).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test('off() removes the pinned listener', () => {
    const { transport, client } = setup();
    const scoped = createSessionScopedCDP(client, 'page-a');

    const calls: unknown[] = [];
    const handler = (p: Record<string, unknown>) => calls.push(p);
    scoped.on('Page.loadEventFired', handler);
    scoped.off('Page.loadEventFired', handler);

    transport.emitEvent('Page.loadEventFired', { n: 1 }, 'page-a');
    expect(calls).toHaveLength(0);
  });

  test('two scoped views over one client each receive only their own events', () => {
    const { transport, client } = setup();
    const viewA = createSessionScopedCDP(client, 'page-a');
    const viewB = createSessionScopedCDP(client, 'page-b');

    const aCalls: unknown[] = [];
    const bCalls: unknown[] = [];
    viewA.on('Page.frameNavigated', (p) => aCalls.push(p));
    viewB.on('Page.frameNavigated', (p) => bCalls.push(p));

    transport.emitEvent('Page.frameNavigated', { who: 'a' }, 'page-a');
    transport.emitEvent('Page.frameNavigated', { who: 'b' }, 'page-b');

    expect(aCalls).toEqual([{ who: 'a' }]);
    expect(bCalls).toEqual([{ who: 'b' }]);
  });

  test('registering the same handler twice is idempotent (fires once)', () => {
    const { transport, client } = setup();
    const scoped = createSessionScopedCDP(client, 'page-a');

    const calls: unknown[] = [];
    const handler = (p: Record<string, unknown>) => calls.push(p);
    scoped.on('Page.loadEventFired', handler);
    scoped.on('Page.loadEventFired', handler);

    transport.emitEvent('Page.loadEventFired', { n: 1 }, 'page-a');
    expect(calls).toHaveLength(1);
  });
});
