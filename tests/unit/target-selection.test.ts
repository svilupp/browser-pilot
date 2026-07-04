/**
 * Unit tests for target selection heuristics and viewport validation
 */

import { describe, expect, test } from 'bun:test';
import type { TargetInfo } from '../../src/cdp/protocol.ts';

type CDPCall = { method: string; params?: Record<string, unknown> };
type EventHandler = (params: Record<string, unknown>) => void;
type AnyEventHandler = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string
) => void;

function createMockCDPClient() {
  const responses = new Map<string, unknown>();
  const eventHandlers = new Map<string, Set<EventHandler>>();
  const anyHandlers = new Set<AnyEventHandler>();

  return {
    sent: [] as CDPCall[],

    async send(method: string, params?: Record<string, unknown>) {
      this.sent.push({ method, params });

      if (responses.has(method)) {
        return responses.get(method);
      }

      if (method === 'Target.attachToTarget') {
        return { sessionId: 'mock-session-id' };
      }
      if (method === 'Target.createTarget') {
        return { targetId: 'new-target-id' };
      }

      return {};
    },

    on(_event: string, _handler: EventHandler) {
      if (!eventHandlers.has(_event)) {
        eventHandlers.set(_event, new Set());
      }
      eventHandlers.get(_event)!.add(_handler);
    },

    off(_event: string, _handler: EventHandler) {
      eventHandlers.get(_event)?.delete(_handler);
    },

    // Firehose used by the session-scoped view that Browser.page() wraps a page
    // in; the scope routes on()/off() through onAny()/offAny().
    onAny(handler: AnyEventHandler) {
      anyHandlers.add(handler);
    },

    offAny(handler: AnyEventHandler) {
      anyHandlers.delete(handler);
    },

    onSessionEvent(_sessionId: string, _event: string, _handler: EventHandler) {
      return () => {};
    },

    onTargetAttached(_handler: (info: unknown) => void) {
      return () => {};
    },

    async setAutoAttach() {},

    async runIfWaitingForDebugger() {},

    hasSession(_sessionId: string) {
      return false;
    },

    get sessions() {
      return new Set<string>();
    },

    sessionId: 'mock-session-id' as string | undefined,

    setSessionId(sessionId: string | undefined) {
      this.sessionId = sessionId;
    },

    mockResponse(method: string, response: unknown) {
      responses.set(method, response);
    },

    findCall(method: string): CDPCall | undefined {
      return this.sent.find((c) => c.method === method);
    },

    get isConnected() {
      return true;
    },

    async attachToTarget(_targetId: string): Promise<string> {
      this.sent.push({ method: 'Target.attachToTarget', params: { targetId: _targetId } });
      return 'mock-session-id';
    },

    async close() {},
  };
}

function makeTarget(overrides: Partial<TargetInfo> & { targetId: string }): TargetInfo {
  return {
    type: 'page',
    title: '',
    url: 'about:blank',
    attached: false,
    canAccessOpener: false,
    ...overrides,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: test helper bypasses private constructor
type AnyBrowser = any;

async function createBrowserWithTargets(
  targets: TargetInfo[],
  evalResult?: { w: number; h: number }
) {
  const { Browser } = await import('../../src/browser/browser.ts');
  const cdp = createMockCDPClient();

  cdp.mockResponse('Target.getTargets', { targetInfos: targets });

  if (evalResult) {
    cdp.mockResponse('Runtime.evaluate', {
      result: { value: evalResult },
    });
  } else {
    cdp.mockResponse('Runtime.evaluate', {
      result: { value: { w: 1280, h: 720 } },
    });
  }

  // Bypass private constructor for testing
  const browser: AnyBrowser = Object.create(Browser.prototype);
  browser.cdp = cdp;
  browser.pages = new Map();
  browser.providerSession = {
    wsUrl: 'ws://test',
    metadata: {},
    close: async () => {},
  };

  return { browser, cdp };
}

describe('Target Selection', () => {
  test('prefers http targets over chrome:// and about:blank', async () => {
    const targets = [
      makeTarget({ targetId: 'chrome', url: 'chrome://newtab', title: 'New Tab' }),
      makeTarget({ targetId: 'blank', url: 'about:blank' }),
      makeTarget({ targetId: 'app', url: 'http://localhost:3000/app', title: 'My App' }),
    ];

    const { browser, cdp } = await createBrowserWithTargets(targets);
    await browser.page();

    const attachCall = cdp.findCall('Target.attachToTarget');
    expect(attachCall?.params?.['targetId']).toBe('app');
  });

  test('prefers https over chrome-extension and devtools', async () => {
    const targets = [
      makeTarget({
        targetId: 'ext',
        url: 'chrome-extension://abc/popup.html',
        title: 'Extension',
      }),
      makeTarget({ targetId: 'devtools', url: 'devtools://devtools/bundled/inspector.html' }),
      makeTarget({ targetId: 'site', url: 'https://example.com', title: 'Example' }),
    ];

    const { browser, cdp } = await createBrowserWithTargets(targets);
    await browser.page();

    const attachCall = cdp.findCall('Target.attachToTarget');
    expect(attachCall?.params?.['targetId']).toBe('site');
  });

  test('prefers unattached targets', async () => {
    const targets = [
      makeTarget({
        targetId: 'attached',
        url: 'http://localhost:3000',
        title: 'App',
        attached: true,
      }),
      makeTarget({
        targetId: 'free',
        url: 'http://localhost:3000',
        title: 'App',
        attached: false,
      }),
    ];

    const { browser, cdp } = await createBrowserWithTargets(targets);
    await browser.page();

    const attachCall = cdp.findCall('Target.attachToTarget');
    expect(attachCall?.params?.['targetId']).toBe('free');
  });

  test('prefers targets with titles', async () => {
    const targets = [
      makeTarget({ targetId: 'no-title', url: 'http://localhost:3000' }),
      makeTarget({ targetId: 'titled', url: 'http://localhost:3000', title: 'My App' }),
    ];

    const { browser, cdp } = await createBrowserWithTargets(targets);
    await browser.page();

    const attachCall = cdp.findCall('Target.attachToTarget');
    expect(attachCall?.params?.['targetId']).toBe('titled');
  });

  test('creates new target when no page targets exist', async () => {
    const targets = [
      makeTarget({
        targetId: 'worker',
        type: 'service_worker',
        url: 'http://localhost:3000/sw.js',
      }),
    ];

    const { browser, cdp } = await createBrowserWithTargets(targets);
    await browser.page();

    const createCall = cdp.findCall('Target.createTarget');
    expect(createCall).toBeDefined();
  });

  test('filters by targetUrl when provided', async () => {
    const targets = [
      makeTarget({ targetId: 'other', url: 'http://localhost:8080/admin', title: 'Admin' }),
      makeTarget({ targetId: 'app', url: 'http://localhost:3000/login', title: 'Login' }),
    ];

    const { browser, cdp } = await createBrowserWithTargets(targets);
    await browser.page(undefined, { targetUrl: 'localhost:3000' });

    const attachCall = cdp.findCall('Target.attachToTarget');
    expect(attachCall?.params?.['targetId']).toBe('app');
  });

  test('falls back to all targets when targetUrl matches nothing', async () => {
    const targets = [
      makeTarget({ targetId: 'app', url: 'http://localhost:3000/login', title: 'Login' }),
    ];

    const { browser, cdp } = await createBrowserWithTargets(targets);
    await browser.page(undefined, { targetUrl: 'nonexistent.com' });

    const attachCall = cdp.findCall('Target.attachToTarget');
    expect(attachCall?.params?.['targetId']).toBe('app');
  });

  test('uses explicit targetId when provided and valid', async () => {
    const targets = [
      makeTarget({ targetId: 'first', url: 'http://example.com', title: 'First' }),
      makeTarget({ targetId: 'second', url: 'http://other.com', title: 'Second' }),
    ];

    const { browser, cdp } = await createBrowserWithTargets(targets);
    await browser.page(undefined, { targetId: 'second' });

    const attachCall = cdp.findCall('Target.attachToTarget');
    expect(attachCall?.params?.['targetId']).toBe('second');
  });

  test('falls back when explicit targetId no longer exists', async () => {
    const targets = [makeTarget({ targetId: 'only', url: 'http://example.com', title: 'Page' })];

    const { browser, cdp } = await createBrowserWithTargets(targets);
    await browser.page(undefined, { targetId: 'gone-target' });

    const attachCall = cdp.findCall('Target.attachToTarget');
    expect(attachCall?.params?.['targetId']).toBe('only');
  });
});

describe('Viewport Validation', () => {
  test('applies viewport override when target has pathological dimensions', async () => {
    const targets = [makeTarget({ targetId: 'tiny', url: 'http://localhost:3000', title: 'App' })];

    const { browser, cdp } = await createBrowserWithTargets(targets, { w: 921, h: 56 });
    await browser.page();

    const emulationCall = cdp.findCall('Emulation.setDeviceMetricsOverride');
    expect(emulationCall).toBeDefined();
    expect(emulationCall?.params?.['width']).toBe(1280);
    expect(emulationCall?.params?.['height']).toBe(720);
  });

  test('does not override viewport when dimensions are normal', async () => {
    const targets = [
      makeTarget({ targetId: 'normal', url: 'http://localhost:3000', title: 'App' }),
    ];

    const { browser, cdp } = await createBrowserWithTargets(targets, { w: 1440, h: 900 });
    await browser.page();

    const emulationCall = cdp.findCall('Emulation.setDeviceMetricsOverride');
    expect(emulationCall).toBeUndefined();
  });

  test('respects custom minViewport threshold', async () => {
    const targets = [makeTarget({ targetId: 'small', url: 'http://localhost:3000', title: 'App' })];

    // With default threshold (200x200), 400x300 should pass
    const { browser: b1, cdp: c1 } = await createBrowserWithTargets(targets, { w: 400, h: 300 });
    await b1.page();
    expect(c1.findCall('Emulation.setDeviceMetricsOverride')).toBeUndefined();

    // With higher threshold (500x500), 400x300 should trigger override
    const { browser: b2, cdp: c2 } = await createBrowserWithTargets(targets, { w: 400, h: 300 });
    await b2.page(undefined, { minViewport: { width: 500, height: 500 } });
    expect(c2.findCall('Emulation.setDeviceMetricsOverride')).toBeDefined();
  });

  test('skips viewport check when minViewport is false', async () => {
    const targets = [makeTarget({ targetId: 'tiny', url: 'http://localhost:3000', title: 'App' })];

    const { browser, cdp } = await createBrowserWithTargets(targets, { w: 921, h: 56 });
    await browser.page(undefined, { minViewport: false });

    const emulationCall = cdp.findCall('Emulation.setDeviceMetricsOverride');
    expect(emulationCall).toBeUndefined();
  });
});
