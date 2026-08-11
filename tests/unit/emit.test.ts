/**
 * Unit tests for emit (message injection) against a mocked CDP surface.
 *
 * The behaviours pinned here come from learning tests against real Chrome:
 *   - closed sockets stay enumerable and swallow sends silently
 *   - sockets live in exactly one realm, so sweeps must cover all of them
 *   - delivery is only proven by Network.webSocketFrameSent
 */

import { describe, expect, test } from 'bun:test';
import { validateSteps } from '../../src/actions/validate.ts';
import {
  type EmitRealm,
  EmitTargetError,
  emitWsMessage,
  listSockets,
  matchesWhere,
} from '../../src/browser/emit.ts';
import type { CDPClient } from '../../src/cdp/client.ts';
import { parseAwaitExpression, parseEmitArgs } from '../../src/cli/commands/emit.ts';

type Socket = { url: string; readyState: number };
type EventHandler = (params: Record<string, unknown>) => void;

interface MockRealm {
  /** Realm location, used as the frame label. */
  href: string;
  sockets: Socket[];
}

interface MockOptions {
  /**
   * Realms per CDP session. Key 'main' is the page's own session; other keys
   * are flat child sessions (workers, OOPIFs). Within a session, index 0 is
   * that session's own global and the rest are its same-origin frames - the
   * same shape the frame tree produces in a real page.
   */
  sessions: Record<string, MockRealm[]>;
  /** Emit a webSocketFrameSent event when the page sends (default true). */
  confirmSend?: boolean;
  /** Reply payload delivered right after a send. */
  replyPayload?: string;
  /** Session id the reply/confirmation events are delivered on. */
  eventSessionId?: string;
  /** CDP requestId reported on the sent-frame confirmation (default 'req-1'). */
  sentRequestId?: string;
  /** CDP requestId reported on the reply frame (default: same as sentRequestId). */
  replyRequestId?: string;
  /** Fire an extra reply-shaped frame on a different requestId, simulating a competing socket. */
  competingReplyPayload?: string;
}

/**
 * Mocks the CDP calls emit relies on, including the ownership rule that makes
 * this design necessary: a realm's sockets are only reachable through an
 * object id that realm itself owns (`proto:<session>:<realm index>`).
 */
function createMockCDP(options: MockOptions) {
  const handlers = new Map<string, Set<EventHandler>>();
  const sessionHandlers = new Map<string, Map<string, Set<EventHandler>>>();
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const emitted: string[] = [];
  const frameIdByBackendNode = new Map<number, string>();

  const fire = (event: string, params: Record<string, unknown>) => {
    const target = options.eventSessionId;
    if (target) {
      for (const handler of sessionHandlers.get(target)?.get(event) ?? []) handler(params);
      return;
    }
    for (const handler of handlers.get(event) ?? []) handler(params);
  };

  const realmAt = (ref: string): MockRealm | undefined => {
    const [sessionKey, index] = ref.split(':');
    return (options.sessions[sessionKey ?? ''] ?? [])[Number(index)];
  };

  const client = {
    sent,
    emitted,

    async send(method: string, params?: Record<string, unknown>, sessionId?: string | null) {
      sent.push({ method, params });
      const key = sessionId ?? 'main';
      const realms = options.sessions[key] ?? [];
      const objectId = String(params?.['objectId'] ?? '');

      if (method === 'Runtime.evaluate') {
        return realms.length > 0 ? { result: { objectId: `proto:${key}:0` } } : { result: {} };
      }

      if (method === 'Page.getFrameTree') {
        if (realms.length === 0) throw new Error('No frame tree in this session');
        return {
          frameTree: {
            frame: { id: `${key}:0`, url: realms[0]?.href ?? '' },
            childFrames: realms.slice(1).map((realm, index) => ({
              frame: { id: `${key}:${index + 1}`, url: realm.href },
            })),
          },
        };
      }

      if (method === 'DOM.getFrameOwner') {
        const frameId = String(params?.['frameId'] ?? '');
        const backendNodeId = frameIdByBackendNode.size + 1000;
        frameIdByBackendNode.set(backendNodeId, frameId);
        return { backendNodeId };
      }
      if (method === 'DOM.describeNode') {
        const backendNodeId = Number(params?.['backendNodeId']);
        return { node: { contentDocument: { backendNodeId } } };
      }
      if (method === 'DOM.resolveNode') {
        const frameId = frameIdByBackendNode.get(Number(params?.['backendNodeId']));
        return frameId ? { object: { objectId: `doc:${frameId}` } } : {};
      }

      if (method === 'Runtime.queryObjects') {
        const protoRef = String(params?.['prototypeObjectId'] ?? '').replace('proto:', '');
        return { objects: { objectId: `array:${protoRef}` } };
      }

      if (method === 'Runtime.callFunctionOn') {
        const declaration = String(params?.['functionDeclaration'] ?? '');

        if (objectId.startsWith('doc:')) {
          return { result: { objectId: `proto:${objectId.replace('doc:', '')}` } };
        }

        const realmSockets = realmAt(objectId.replace('array:', ''))?.sockets ?? [];

        if (declaration.includes('readyState: s.readyState')) {
          return { result: { value: JSON.stringify(realmSockets) } };
        }

        // The send path: mirror the browser's real contract - a socket that is
        // not OPEN silently discards the frame.
        const args = (params?.['arguments'] ?? []) as Array<{ value: unknown }>;
        const payload = String(args[0]?.value ?? '');
        const url = String(args[1]?.value ?? '');
        const socket = realmSockets.find((s) => s.url === url && s.readyState === 1);
        if (!socket) {
          return { result: { value: JSON.stringify({ ok: false, reason: 'closed-before-send' }) } };
        }
        emitted.push(payload);
        const sentRequestId = options.sentRequestId ?? 'req-1';
        if (options.confirmSend !== false) {
          queueMicrotask(() =>
            fire('Network.webSocketFrameSent', {
              requestId: sentRequestId,
              response: { payloadData: payload, opcode: 1 },
            })
          );
        }
        if (options.replyPayload !== undefined) {
          queueMicrotask(() =>
            fire('Network.webSocketFrameReceived', {
              requestId: options.replyRequestId ?? sentRequestId,
              response: { payloadData: options.replyPayload },
            })
          );
        }
        if (options.competingReplyPayload !== undefined) {
          queueMicrotask(() =>
            fire('Network.webSocketFrameReceived', {
              requestId: 'req-competing',
              response: { payloadData: options.competingReplyPayload },
            })
          );
        }
        return { result: { value: JSON.stringify({ ok: true, bufferedAmount: 0 }) } };
      }
      return {};
    },

    on(event: string, handler: EventHandler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },

    off(event: string, handler: EventHandler) {
      handlers.get(event)?.delete(handler);
    },

    onSessionEvent(sessionId: string, event: string, handler: EventHandler) {
      if (!sessionHandlers.has(sessionId)) sessionHandlers.set(sessionId, new Map());
      const perSession = sessionHandlers.get(sessionId)!;
      if (!perSession.has(event)) perSession.set(event, new Set());
      perSession.get(event)!.add(handler);
      return () => perSession.get(event)?.delete(handler);
    },

    handlerCount(event: string) {
      let total = handlers.get(event)?.size ?? 0;
      for (const perSession of sessionHandlers.values()) {
        total += perSession.get(event)?.size ?? 0;
      }
      return total;
    },
  };

  return client;
}

/** A page whose only realm holds the given sockets. */
function singleRealm(sockets: Socket[]): Record<string, MockRealm[]> {
  return { main: [{ href: 'https://app.example/', sockets }] };
}

const MAIN: EmitRealm[] = [{ kind: 'main', label: 'main' }];

describe('listSockets', () => {
  test('sweeps every realm and labels where each socket lives', async () => {
    const cdp = createMockCDP({
      sessions: {
        // One page session holding a main realm and a same-origin frame, plus
        // a worker on its own session.
        main: [
          { href: 'https://app.example/', sockets: [{ url: 'wss://app/main', readyState: 1 }] },
          {
            href: 'https://app.example/child',
            sockets: [{ url: 'wss://app/frame', readyState: 1 }],
          },
        ],
        'worker-session': [
          {
            href: 'blob:https://app.example/w',
            sockets: [{ url: 'wss://app/worker', readyState: 1 }],
          },
        ],
      },
    });

    const sockets = await listSockets(cdp as unknown as CDPClient, [
      { kind: 'main', label: 'main' },
      { kind: 'worker', sessionId: 'worker-session', label: 'worker:blob:x' },
    ]);

    expect(sockets.map((s) => s.url)).toEqual([
      'wss://app/main',
      'wss://app/frame',
      'wss://app/worker',
    ]);
    expect(sockets.map((s) => s.realm)).toEqual(['main', 'frame', 'worker']);
    expect(sockets[1]?.realmLabel).toBe('frame:https://app.example/child');
    expect(sockets[2]?.realmLabel).toBe('worker:blob:x');
  });

  test('a realm that throws contributes nothing instead of failing the sweep', async () => {
    const cdp = createMockCDP({
      sessions: singleRealm([{ url: 'wss://app/main', readyState: 1 }]),
    });
    const original = cdp.send.bind(cdp);
    cdp.send = async (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string | null
    ) => {
      if (sessionId === 'dead-session') throw new Error('Session closed');
      return original(method, params, sessionId);
    };

    const sockets = await listSockets(cdp as unknown as CDPClient, [
      { kind: 'main', label: 'main' },
      { kind: 'worker', sessionId: 'dead-session', label: 'worker:gone' },
    ]);

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe('wss://app/main');
  });
});

describe('emitWsMessage selection', () => {
  test('sends on the only open socket', async () => {
    const cdp = createMockCDP({
      sessions: singleRealm([{ url: 'wss://app/live', readyState: 1 }]),
    });

    const result = await emitWsMessage(cdp as unknown as CDPClient, MAIN, '{"type":"ping"}');

    expect(result.delivered).toBe(true);
    expect(result.socketUrl).toBe('wss://app/live');
    expect(cdp.emitted).toEqual(['{"type":"ping"}']);
  });

  test('never picks a CLOSED socket, because a send on one is silently discarded', async () => {
    const cdp = createMockCDP({
      sessions: singleRealm([
        { url: 'wss://app/dead', readyState: 3 },
        { url: 'wss://app/live', readyState: 1 },
      ]),
    });

    const result = await emitWsMessage(cdp as unknown as CDPClient, MAIN, 'hi');
    expect(result.socketUrl).toBe('wss://app/live');
  });

  test('refuses to guess between several open sockets', async () => {
    const cdp = createMockCDP({
      sessions: singleRealm([
        { url: 'wss://app/chat', readyState: 1 },
        { url: 'wss://app/analytics', readyState: 1 },
      ]),
    });

    const promise = emitWsMessage(cdp as unknown as CDPClient, MAIN, 'hi');
    await expect(promise).rejects.toThrow(EmitTargetError);
    await expect(promise).rejects.toThrow(/Ambiguous/);
    expect(cdp.emitted).toEqual([]);
  });

  test('--match disambiguates', async () => {
    const cdp = createMockCDP({
      sessions: singleRealm([
        { url: 'wss://app/chat', readyState: 1 },
        { url: 'wss://app/analytics', readyState: 1 },
      ]),
    });

    const result = await emitWsMessage(cdp as unknown as CDPClient, MAIN, 'hi', {
      match: '*chat*',
    });
    expect(result.socketUrl).toBe('wss://app/chat');
  });

  test('a bare --match substring is treated as a substring, not an exact URL', async () => {
    const cdp = createMockCDP({
      sessions: singleRealm([
        { url: 'wss://app/chat', readyState: 1 },
        { url: 'wss://app/analytics', readyState: 1 },
      ]),
    });

    const result = await emitWsMessage(cdp as unknown as CDPClient, MAIN, 'hi', { match: 'chat' });
    expect(result.socketUrl).toBe('wss://app/chat');
  });

  test('reports every candidate when nothing is open', async () => {
    const cdp = createMockCDP({
      sessions: singleRealm([{ url: 'wss://app/dead', readyState: 3 }]),
    });

    try {
      await emitWsMessage(cdp as unknown as CDPClient, MAIN, 'hi');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(EmitTargetError);
      expect((error as EmitTargetError).candidates).toHaveLength(1);
      expect((error as Error).message).toContain('readyState=3');
    }
  });

  test('a socket that closes between sweep and send fails loudly', async () => {
    // The mock's send path re-checks readyState exactly as the injected
    // function does in the page, so a stale sweep cannot report success.
    const sockets = [{ url: 'wss://app/live', readyState: 1 }];
    const cdp = createMockCDP({ sessions: { main: [{ href: 'https://app/', sockets }] } });
    const original = cdp.send.bind(cdp);
    cdp.send = async (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string | null
    ) => {
      const declaration = String(params?.['functionDeclaration'] ?? '');
      if (method === 'Runtime.callFunctionOn' && declaration.includes('closed-before-send')) {
        sockets[0]!.readyState = 3; // closed in the race window
      }
      return original(method, params, sessionId);
    };

    await expect(emitWsMessage(cdp as unknown as CDPClient, MAIN, 'hi')).rejects.toThrow(
      /closed before the frame could be sent/
    );
  });
});

describe('emitWsMessage delivery proof', () => {
  test('an unobserved frame is reported as unconfirmed, not as success', async () => {
    const cdp = createMockCDP({
      sessions: singleRealm([{ url: 'wss://app/live', readyState: 1 }]),
      confirmSend: false,
    });

    const result = await emitWsMessage(cdp as unknown as CDPClient, MAIN, 'hi', {
      confirmTimeout: 20,
    });

    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('dispatched-unconfirmed');
  });

  test('listeners are removed after the emit settles', async () => {
    const cdp = createMockCDP({
      sessions: singleRealm([{ url: 'wss://app/live', readyState: 1 }]),
    });

    await emitWsMessage(cdp as unknown as CDPClient, MAIN, 'hi', { confirmTimeout: 20 });

    expect(cdp.handlerCount('Network.webSocketFrameSent')).toBe(0);
    expect(cdp.handlerCount('Network.webSocketFrameReceived')).toBe(0);
  });
});

describe('emitWsMessage awaitReply', () => {
  test('returns the matching reply with a latency measurement', async () => {
    const cdp = createMockCDP({
      sessions: singleRealm([{ url: 'wss://app/live', readyState: 1 }]),
      replyPayload: '{"type":"pong","id":7}',
    });

    const result = await emitWsMessage(cdp as unknown as CDPClient, MAIN, '{"type":"ping"}', {
      awaitReply: { where: { type: 'pong' }, timeout: 200 },
    });

    expect(result.reply?.payload).toBe('{"type":"pong","id":7}');
    expect(result.reply?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("--await-match '*' matches a pretty-printed multi-line JSON reply", async () => {
    const multilineReply = '{\n  "type": "pong",\n  "id": 7\n}';
    const cdp = createMockCDP({
      sessions: singleRealm([{ url: 'wss://app/live', readyState: 1 }]),
      replyPayload: multilineReply,
    });

    const result = await emitWsMessage(cdp as unknown as CDPClient, MAIN, '{"type":"ping"}', {
      awaitReply: { match: '*', timeout: 200 },
    });

    expect(result.reply?.payload).toBe(multilineReply);
  });

  test('a non-matching reply does not satisfy the wait', async () => {
    const cdp = createMockCDP({
      sessions: singleRealm([{ url: 'wss://app/live', readyState: 1 }]),
      replyPayload: '{"type":"heartbeat"}',
    });

    const result = await emitWsMessage(cdp as unknown as CDPClient, MAIN, '{"type":"ping"}', {
      awaitReply: { where: { type: 'pong' }, timeout: 50 },
    });

    expect(result.reply).toBeUndefined();
  });

  test('a matching-shaped reply on a competing socket (different requestId) does not satisfy the wait', async () => {
    // Same CDP event stream, but the frame belongs to a different WebSocket
    // connection - correlation by requestId must reject it even though its
    // payload would otherwise match `where`.
    const cdp = createMockCDP({
      sessions: singleRealm([{ url: 'wss://app/live', readyState: 1 }]),
      competingReplyPayload: '{"type":"pong","id":999}',
    });

    const result = await emitWsMessage(cdp as unknown as CDPClient, MAIN, '{"type":"ping"}', {
      awaitReply: { where: { type: 'pong' }, timeout: 50 },
    });

    expect(result.reply).toBeUndefined();
  });

  test('a reply on the correlated requestId wins even alongside a competing-socket frame', async () => {
    const cdp = createMockCDP({
      sessions: singleRealm([{ url: 'wss://app/live', readyState: 1 }]),
      replyPayload: '{"type":"pong","id":1}',
      competingReplyPayload: '{"type":"pong","id":999}',
    });

    const result = await emitWsMessage(cdp as unknown as CDPClient, MAIN, '{"type":"ping"}', {
      awaitReply: { where: { type: 'pong' }, timeout: 200 },
    });

    expect(result.reply?.payload).toBe('{"type":"pong","id":1}');
  });

  test('timers are cleared immediately on an early match, not left pending until timeout', async () => {
    const cdp = createMockCDP({
      sessions: singleRealm([{ url: 'wss://app/live', readyState: 1 }]),
      replyPayload: '{"type":"pong"}',
    });

    const started = Date.now();
    const result = await emitWsMessage(cdp as unknown as CDPClient, MAIN, '{"type":"ping"}', {
      confirmTimeout: 5000,
      awaitReply: { where: { type: 'pong' }, timeout: 5000 },
    });
    const elapsed = Date.now() - started;

    expect(result.reply?.payload).toBe('{"type":"pong"}');
    // A long confirm/reply timeout must not be waited out when the frames
    // resolve immediately - proves the pending timers are cleared, not just
    // superseded by an early promise resolution.
    expect(elapsed).toBeLessThan(500);
  });

  test('listeners and timers are cleared when the send is never confirmed', async () => {
    const cdp = createMockCDP({
      sessions: singleRealm([{ url: 'wss://app/live', readyState: 1 }]),
      confirmSend: false,
    });

    const started = Date.now();
    const result = await emitWsMessage(cdp as unknown as CDPClient, MAIN, 'hi', {
      confirmTimeout: 30,
      awaitReply: { timeout: 30 },
    });
    const elapsed = Date.now() - started;

    expect(result.delivered).toBe(false);
    expect(result.reply).toBeUndefined();
    expect(elapsed).toBeLessThan(200);
    expect(cdp.handlerCount('Network.webSocketFrameSent')).toBe(0);
    expect(cdp.handlerCount('Network.webSocketFrameReceived')).toBe(0);
  });
});

describe('matchesWhere', () => {
  test('matches nested dot paths', () => {
    expect(matchesWhere('{"data":{"eventType":"tick"}}', { 'data.eventType': 'tick' })).toBe(true);
    expect(matchesWhere('{"data":{"eventType":"tick"}}', { 'data.eventType': 'other' })).toBe(
      false
    );
  });

  test('non-JSON payloads never match a field expectation', () => {
    expect(matchesWhere('not json', { type: 'pong' })).toBe(false);
  });
});

describe('emit step validation', () => {
  test('accepts an emit step with an object payload', () => {
    const result = validateSteps([{ action: 'emit', payload: { type: 'ping' } }]);
    expect(result.valid).toBe(true);
  });

  test('requires a payload', () => {
    const result = validateSteps([{ action: 'emit' }]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.field).toBe('payload');
  });

  test('rejects retry, because a re-sent frame duplicates a server-side action', () => {
    const result = validateSteps([{ action: 'emit', payload: 'x', retry: 2 }]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.field).toBe('retry');
    expect(result.errors[0]?.message).toContain('duplicates');
  });

  test('allows retry: 0, which asks for nothing', () => {
    const result = validateSteps([{ action: 'emit', payload: 'x', retry: 0 }]);
    expect(result.valid).toBe(true);
  });

  test('rejects an unsupported channel', () => {
    const result = validateSteps([{ action: 'emit', payload: 'x', channel: 'grpc' }]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.field).toBe('channel');
  });
});

describe('emit CLI parsing', () => {
  test('parses channel, payload, and match', () => {
    const options = parseEmitArgs(['ws', '{"type":"ping"}', '--match', '*chat*']);
    expect(options.channel).toBe('ws');
    expect(options.payload).toBe('{"type":"ping"}');
    expect(options.match).toBe('*chat*');
  });

  test('collects repeated --await expressions into one matcher', () => {
    const options = parseEmitArgs(['ws', 'x', '--await', 'type=pong', '--await', 'ok=true']);
    expect(options.awaitWhere).toEqual({ type: 'pong', ok: true });
  });

  test('--list needs no payload', () => {
    const options = parseEmitArgs(['ws', '--list']);
    expect(options.list).toBe(true);
    expect(options.payload).toBeUndefined();
  });

  test('coerces await values so numeric fields match JSON numbers', () => {
    expect(parseAwaitExpression('turn=3')).toEqual(['turn', 3]);
    expect(parseAwaitExpression('ok=false')).toEqual(['ok', false]);
    expect(parseAwaitExpression('type=user.transcript')).toEqual(['type', 'user.transcript']);
  });

  test('keeps everything after the first = so JSON values survive', () => {
    expect(parseAwaitExpression('data.raw={"a":1}')).toEqual(['data.raw', '{"a":1}']);
  });

  test('rejects an expression with no =', () => {
    expect(() => parseAwaitExpression('type')).toThrow(/Expected key=value/);
  });
});
