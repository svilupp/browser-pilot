/**
 * Unit tests for Listen command (network traffic monitor)
 */

import { describe, expect, test } from 'bun:test';
import type { CDPClient } from '../../src/cdp/client.ts';
import {
  globToRegex,
  type ListenMode,
  parseListenArgs,
  TrafficMonitor,
  type TrafficMonitorOptions,
} from '../../src/cli/commands/listen.ts';

type EventHandler = (params: Record<string, unknown>) => void;

function createMockCDPClient() {
  const eventHandlers = new Map<string, Set<EventHandler>>();

  return {
    sent: [] as Array<{ method: string; params?: Record<string, unknown> }>,

    async send(method: string, params?: Record<string, unknown>) {
      this.sent.push({ method, params });
      return {};
    },

    on(event: string, handler: EventHandler) {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, new Set());
      }
      eventHandlers.get(event)!.add(handler);
    },

    off(event: string, handler: EventHandler) {
      eventHandlers.get(event)?.delete(handler);
    },

    onAny() {},

    emit(event: string, params: Record<string, unknown>) {
      const handlers = eventHandlers.get(event);
      if (handlers) {
        for (const h of handlers) {
          h(params);
        }
      }
    },

    hasHandlers(event: string): boolean {
      const handlers = eventHandlers.get(event);
      return !!handlers && handlers.size > 0;
    },

    get isConnected() {
      return true;
    },
    get sessionId() {
      return undefined;
    },
    async close() {},
    async attachToTarget() {
      return '';
    },
  };
}

function createMonitor(
  cdp: ReturnType<typeof createMockCDPClient>,
  overrides: Partial<TrafficMonitorOptions> = {}
) {
  const lines: string[] = [];
  const opts: TrafficMonitorOptions = {
    mode: 'all' as ListenMode,
    maxPayload: 256,
    write: (line: string) => lines.push(line),
    ...overrides,
  };
  const monitor = new TrafficMonitor(cdp as unknown as CDPClient, opts);
  return { monitor, lines, parsed: () => lines.map((l) => JSON.parse(l)) };
}

// --- Arg parsing ---

describe('parseListenArgs', () => {
  test('detects mode subcommand', () => {
    expect(parseListenArgs(['ws']).mode).toBe('ws');
    expect(parseListenArgs(['http']).mode).toBe('http');
    expect(parseListenArgs(['all']).mode).toBe('all');
  });

  test('parses --match / -m', () => {
    expect(parseListenArgs(['-m', '*realtime*']).match).toBe('*realtime*');
    expect(parseListenArgs(['--match', '*voice*']).match).toBe('*voice*');
  });

  test('parses -o / --output', () => {
    expect(parseListenArgs(['-o', 'out.jsonl']).output).toBe('out.jsonl');
    expect(parseListenArgs(['--output', 'trace.jsonl']).output).toBe('trace.jsonl');
  });

  test('parses --max-payload', () => {
    expect(parseListenArgs(['--max-payload', '512']).maxPayload).toBe(512);
  });

  test('parses --timeout', () => {
    expect(parseListenArgs(['--timeout', '30000']).timeout).toBe(30000);
  });

  test('parses -q / --quiet', () => {
    expect(parseListenArgs(['-q']).quiet).toBe(true);
    expect(parseListenArgs(['--quiet']).quiet).toBe(true);
  });

  test('parses combined args', () => {
    const opts = parseListenArgs([
      'ws',
      '-m',
      '*api*',
      '-o',
      'out.jsonl',
      '--max-payload',
      '1024',
      '-q',
    ]);
    expect(opts.mode).toBe('ws');
    expect(opts.match).toBe('*api*');
    expect(opts.output).toBe('out.jsonl');
    expect(opts.maxPayload).toBe(1024);
    expect(opts.quiet).toBe(true);
  });
});

// --- globToRegex ---

describe('globToRegex', () => {
  test('matches wildcard patterns', () => {
    const re = globToRegex('*realtime*');
    expect(re.test('wss://example.com/realtime/session')).toBe(true);
    expect(re.test('wss://example.com/other')).toBe(false);
  });

  test('escapes regex special chars', () => {
    const re = globToRegex('*.example.com/*');
    expect(re.test('https://api.example.com/path')).toBe(true);
    expect(re.test('https://apixexamplexcom/path')).toBe(false);
  });

  test('exact match without wildcards', () => {
    const re = globToRegex('https://exact.com');
    expect(re.test('https://exact.com')).toBe(true);
    expect(re.test('https://exact.com/extra')).toBe(false);
  });
});

// --- WebSocket events ---

describe('WebSocket events', () => {
  test('emits ws:created', () => {
    const cdp = createMockCDPClient();
    const { monitor, parsed } = createMonitor(cdp, { mode: 'ws' });
    monitor.start();

    cdp.emit('Network.webSocketCreated', {
      requestId: '1.2',
      url: 'wss://example.com/session/abc',
    });

    const events = parsed();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('ws:created');
    expect(events[0].requestId).toBe('1.2');
    expect(events[0].url).toBe('wss://example.com/session/abc');
    expect(events[0].ts).toBeDefined();
  });

  test('emits ws:frame:sent for text frames', () => {
    const cdp = createMockCDPClient();
    const { monitor, parsed } = createMonitor(cdp, { mode: 'ws' });
    monitor.start();

    cdp.emit('Network.webSocketCreated', { requestId: '1.2', url: 'wss://example.com' });
    cdp.emit('Network.webSocketFrameSent', {
      requestId: '1.2',
      response: { opcode: 1, payloadData: '{"type":"session.update"}' },
    });

    const events = parsed();
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('ws:frame:sent');
    expect(events[1].opcode).toBe(1);
    expect(events[1].payload).toBe('{"type":"session.update"}');
  });

  test('replaces binary payloads with size placeholder', () => {
    const cdp = createMockCDPClient();
    const { monitor, parsed } = createMonitor(cdp, { mode: 'ws' });
    monitor.start();

    cdp.emit('Network.webSocketCreated', { requestId: '1.2', url: 'wss://example.com' });

    // base64 of 12 bytes = 16 chars (AAAAAAAAAAAAAAAA)
    const base64Data = 'AAAAAAAAAAAAAAAA';
    cdp.emit('Network.webSocketFrameReceived', {
      requestId: '1.2',
      response: { opcode: 2, payloadData: base64Data },
    });

    const events = parsed();
    expect(events[1].type).toBe('ws:frame:recv');
    expect(events[1].opcode).toBe(2);
    expect(events[1].payload).toBe('[binary: 12 bytes]');
  });

  test('truncates long text payloads', () => {
    const cdp = createMockCDPClient();
    const { monitor, parsed } = createMonitor(cdp, { mode: 'ws', maxPayload: 10 });
    monitor.start();

    cdp.emit('Network.webSocketCreated', { requestId: '1.2', url: 'wss://example.com' });
    cdp.emit('Network.webSocketFrameSent', {
      requestId: '1.2',
      response: { opcode: 1, payloadData: 'abcdefghijklmnopqrstuvwxyz' },
    });

    const events = parsed();
    expect(events[1].payload).toBe('abcdefghij... [truncated, 26 total]');
    expect(events[1].length).toBe(26);
  });

  test('emits ws:closed', () => {
    const cdp = createMockCDPClient();
    const { monitor, parsed } = createMonitor(cdp, { mode: 'ws' });
    monitor.start();

    cdp.emit('Network.webSocketCreated', { requestId: '1.2', url: 'wss://example.com' });
    cdp.emit('Network.webSocketClosed', { requestId: '1.2' });

    const events = parsed();
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('ws:closed');
    expect(events[1].requestId).toBe('1.2');
  });

  test('filters WS by URL match', () => {
    const cdp = createMockCDPClient();
    const { monitor, parsed } = createMonitor(cdp, { mode: 'ws', match: '*realtime*' });
    monitor.start();

    cdp.emit('Network.webSocketCreated', {
      requestId: '1.1',
      url: 'wss://example.com/realtime/abc',
    });
    cdp.emit('Network.webSocketCreated', { requestId: '1.2', url: 'wss://example.com/other/xyz' });

    // Frame on matching WS should pass
    cdp.emit('Network.webSocketFrameSent', {
      requestId: '1.1',
      response: { opcode: 1, payloadData: 'hello' },
    });

    // Frame on non-matching WS should be suppressed
    cdp.emit('Network.webSocketFrameSent', {
      requestId: '1.2',
      response: { opcode: 1, payloadData: 'ignored' },
    });

    const events = parsed();
    // Only ws:created for 1.1 + frame for 1.1
    expect(events).toHaveLength(2);
    expect(events[0].requestId).toBe('1.1');
    expect(events[1].requestId).toBe('1.1');
  });

  test('skips frames for unknown requestId', () => {
    const cdp = createMockCDPClient();
    const { monitor, parsed } = createMonitor(cdp, { mode: 'ws' });
    monitor.start();

    // Frame without prior webSocketCreated → should be skipped
    cdp.emit('Network.webSocketFrameReceived', {
      requestId: '999',
      response: { opcode: 1, payloadData: 'orphan' },
    });

    expect(parsed()).toHaveLength(0);
  });
});

// --- HTTP events ---

describe('HTTP events', () => {
  test('emits http:request', () => {
    const cdp = createMockCDPClient();
    const { monitor, parsed } = createMonitor(cdp, { mode: 'http' });
    monitor.start();

    cdp.emit('Network.requestWillBeSent', {
      requestId: '3.1',
      request: { url: 'https://example.com/api/auth', method: 'POST' },
      wallTime: 1709000000.123,
    });

    const events = parsed();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('http:request');
    expect(events[0].method).toBe('POST');
    expect(events[0].url).toBe('https://example.com/api/auth');
  });

  test('emits http:response', () => {
    const cdp = createMockCDPClient();
    const { monitor, parsed } = createMonitor(cdp, { mode: 'http' });
    monitor.start();

    // Must emit request first so requestId is tracked
    cdp.emit('Network.requestWillBeSent', {
      requestId: '3.1',
      request: { url: 'https://example.com/api/auth', method: 'GET' },
    });
    cdp.emit('Network.responseReceived', {
      requestId: '3.1',
      response: { status: 200, mimeType: 'application/json' },
    });

    const events = parsed();
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('http:response');
    expect(events[1].status).toBe(200);
    expect(events[1].mimeType).toBe('application/json');
  });

  test('emits http:failed', () => {
    const cdp = createMockCDPClient();
    const { monitor, parsed } = createMonitor(cdp, { mode: 'http' });
    monitor.start();

    // Must emit request first so requestId is tracked
    cdp.emit('Network.requestWillBeSent', {
      requestId: '3.2',
      request: { url: 'https://example.com/api/fail', method: 'GET' },
    });
    cdp.emit('Network.loadingFailed', {
      requestId: '3.2',
      errorText: 'net::ERR_CONNECTION_REFUSED',
    });

    const events = parsed();
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('http:failed');
    expect(events[1].errorText).toBe('net::ERR_CONNECTION_REFUSED');
  });

  test('filters http:response and http:failed by tracked requestId', () => {
    const cdp = createMockCDPClient();
    const { monitor, parsed } = createMonitor(cdp, { mode: 'http', match: '*/api/*' });
    monitor.start();

    // Matching request
    cdp.emit('Network.requestWillBeSent', {
      requestId: '1',
      request: { url: 'https://example.com/api/users', method: 'GET' },
    });
    // Non-matching request
    cdp.emit('Network.requestWillBeSent', {
      requestId: '2',
      request: { url: 'https://example.com/static/app.js', method: 'GET' },
    });

    // Response for matching request — should pass
    cdp.emit('Network.responseReceived', {
      requestId: '1',
      response: { status: 200, mimeType: 'application/json' },
    });
    // Response for non-matching request — should be filtered
    cdp.emit('Network.responseReceived', {
      requestId: '2',
      response: { status: 200, mimeType: 'text/javascript' },
    });
    // Failed for non-matching request — should be filtered
    cdp.emit('Network.loadingFailed', {
      requestId: '2',
      errorText: 'net::ERR_FAILED',
    });

    const events = parsed();
    // Only: request(1) + response(1)
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('http:request');
    expect(events[1].type).toBe('http:response');
    expect(events[1].requestId).toBe('1');
  });

  test('filters HTTP by URL match', () => {
    const cdp = createMockCDPClient();
    const { monitor, parsed } = createMonitor(cdp, { mode: 'http', match: '*/api/*' });
    monitor.start();

    cdp.emit('Network.requestWillBeSent', {
      requestId: '1',
      request: { url: 'https://example.com/api/users', method: 'GET' },
    });
    cdp.emit('Network.requestWillBeSent', {
      requestId: '2',
      request: { url: 'https://example.com/static/app.js', method: 'GET' },
    });

    const events = parsed();
    expect(events).toHaveLength(1);
    expect(events[0].url).toBe('https://example.com/api/users');
  });
});

// --- Mode filtering ---

describe('Mode filtering', () => {
  test('ws mode ignores HTTP events', () => {
    const cdp = createMockCDPClient();
    const { monitor, parsed } = createMonitor(cdp, { mode: 'ws' });
    monitor.start();

    cdp.emit('Network.requestWillBeSent', {
      requestId: '1',
      request: { url: 'https://example.com', method: 'GET' },
    });

    expect(parsed()).toHaveLength(0);
    expect(cdp.hasHandlers('Network.requestWillBeSent')).toBe(false);
  });

  test('http mode ignores WS events', () => {
    const cdp = createMockCDPClient();
    const { monitor, parsed } = createMonitor(cdp, { mode: 'http' });
    monitor.start();

    cdp.emit('Network.webSocketCreated', { requestId: '1', url: 'wss://example.com' });

    expect(parsed()).toHaveLength(0);
    expect(cdp.hasHandlers('Network.webSocketCreated')).toBe(false);
  });
});

// --- Lifecycle ---

describe('Lifecycle', () => {
  test('stop() unsubscribes all handlers', () => {
    const cdp = createMockCDPClient();
    const { monitor, parsed } = createMonitor(cdp, { mode: 'all' });
    monitor.start();
    monitor.stop();

    // No handlers should remain
    cdp.emit('Network.webSocketCreated', { requestId: '1', url: 'wss://example.com' });
    cdp.emit('Network.requestWillBeSent', {
      requestId: '2',
      request: { url: 'https://example.com', method: 'GET' },
    });

    expect(parsed()).toHaveLength(0);
  });

  test('lineCount tracks correctly', () => {
    const cdp = createMockCDPClient();
    const { monitor } = createMonitor(cdp, { mode: 'ws' });
    monitor.start();

    expect(monitor.lineCount).toBe(0);

    cdp.emit('Network.webSocketCreated', { requestId: '1', url: 'wss://a.com' });
    expect(monitor.lineCount).toBe(1);

    cdp.emit('Network.webSocketFrameSent', {
      requestId: '1',
      response: { opcode: 1, payloadData: 'hi' },
    });
    expect(monitor.lineCount).toBe(2);

    cdp.emit('Network.webSocketClosed', { requestId: '1' });
    expect(monitor.lineCount).toBe(3);
  });
});
