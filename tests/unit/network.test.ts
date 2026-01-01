/**
 * Unit tests for Network Interception features
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import type { CDPClient } from '../../src/cdp/client.ts';
import { RequestInterceptor } from '../../src/network/interceptor.ts';

// Create a mock CDP client for testing
type CDPCall = { method: string; params?: Record<string, unknown> };
type EventHandler = (params: Record<string, unknown>) => void | Promise<void>;

function createMockCDPClient() {
  const responses = new Map<string, unknown>();
  const eventHandlers = new Map<string, Set<EventHandler>>();

  return {
    sent: [] as CDPCall[],

    async send(method: string, params?: Record<string, unknown>) {
      this.sent.push({ method, params });

      if (responses.has(method)) {
        return responses.get(method);
      }

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

    emit(event: string, params: Record<string, unknown>) {
      const handlers = eventHandlers.get(event);
      if (handlers) {
        for (const h of handlers) {
          h(params);
        }
      }
    },

    async emitAsync(event: string, params: Record<string, unknown>) {
      const handlers = eventHandlers.get(event);
      if (handlers) {
        for (const h of handlers) {
          await h(params);
        }
      }
    },

    mockResponse(method: string, response: unknown) {
      responses.set(method, response);
    },

    findCall(method: string): CDPCall | undefined {
      return this.sent.find((c) => c.method === method);
    },

    findAllCalls(method: string): CDPCall[] {
      return this.sent.filter((c) => c.method === method);
    },

    clear() {
      this.sent = [];
    },
  };
}

describe('RequestInterceptor', () => {
  let mockCdp: ReturnType<typeof createMockCDPClient>;
  let interceptor: RequestInterceptor;

  beforeEach(() => {
    mockCdp = createMockCDPClient();
    interceptor = new RequestInterceptor(mockCdp as unknown as CDPClient);
  });

  describe('enable()', () => {
    test('should send Fetch.enable command', async () => {
      await interceptor.enable();

      const call = mockCdp.findCall('Fetch.enable');
      expect(call).toBeDefined();
      expect(call?.params).toMatchObject({
        patterns: [{ urlPattern: '*' }],
        handleAuthRequests: true,
      });
    });

    test('should send custom patterns', async () => {
      await interceptor.enable([
        { urlPattern: '*api*', resourceType: 'XHR' },
        { urlPattern: '*images*', resourceType: 'Image' },
      ]);

      const call = mockCdp.findCall('Fetch.enable');
      expect(call?.params).toMatchObject({
        patterns: [
          { urlPattern: '*api*', resourceType: 'XHR', requestStage: 'Request' },
          { urlPattern: '*images*', resourceType: 'Image', requestStage: 'Request' },
        ],
      });
    });

    test('should not enable twice', async () => {
      await interceptor.enable();
      await interceptor.enable();

      const calls = mockCdp.findAllCalls('Fetch.enable');
      expect(calls).toHaveLength(1);
    });
  });

  describe('disable()', () => {
    test('should send Fetch.disable command', async () => {
      await interceptor.enable();
      await interceptor.disable();

      expect(mockCdp.findCall('Fetch.disable')).toBeDefined();
    });

    test('should not disable if not enabled', async () => {
      await interceptor.disable();

      expect(mockCdp.findCall('Fetch.disable')).toBeUndefined();
    });
  });

  describe('addHandler()', () => {
    test('should return unsubscribe function', async () => {
      await interceptor.enable();

      const handler = async () => {};
      const unsubscribe = interceptor.addHandler({ urlPattern: '*' }, handler);

      expect(typeof unsubscribe).toBe('function');
    });

    test('should call handler for matching requests', async () => {
      await interceptor.enable();

      let handlerCalled = false;
      interceptor.addHandler({ urlPattern: '*api*' }, async (_request, actions) => {
        handlerCalled = true;
        await actions.continue();
      });

      // Simulate request paused event
      await mockCdp.emitAsync('Fetch.requestPaused', {
        requestId: '1',
        request: {
          url: 'https://example.com/api/users',
          method: 'GET',
          headers: {},
        },
        resourceType: 'XHR',
        frameId: 'frame1',
        isNavigationRequest: false,
      });

      expect(handlerCalled).toBe(true);
    });

    test('should not call handler for non-matching requests', async () => {
      await interceptor.enable();

      let handlerCalled = false;
      interceptor.addHandler({ urlPattern: '*api*' }, async (_request, actions) => {
        handlerCalled = true;
        await actions.continue();
      });

      // Simulate request that doesn't match
      await mockCdp.emitAsync('Fetch.requestPaused', {
        requestId: '1',
        request: {
          url: 'https://example.com/images/photo.jpg',
          method: 'GET',
          headers: {},
        },
        resourceType: 'Image',
        frameId: 'frame1',
        isNavigationRequest: false,
      });

      expect(handlerCalled).toBe(false);
      // Should still continue the request
      expect(mockCdp.findCall('Fetch.continueRequest')).toBeDefined();
    });

    test('should match by resource type', async () => {
      await interceptor.enable();

      let handlerCalled = false;
      interceptor.addHandler({ resourceType: 'Image' }, async (_request, actions) => {
        handlerCalled = true;
        await actions.continue();
      });

      await mockCdp.emitAsync('Fetch.requestPaused', {
        requestId: '1',
        request: {
          url: 'https://example.com/photo.jpg',
          method: 'GET',
          headers: {},
        },
        resourceType: 'Image',
        frameId: 'frame1',
        isNavigationRequest: false,
      });

      expect(handlerCalled).toBe(true);
    });
  });

  describe('actions.continue()', () => {
    test('should send Fetch.continueRequest', async () => {
      await interceptor.enable();

      interceptor.addHandler({ urlPattern: '*' }, async (_request, actions) => {
        await actions.continue();
      });

      await mockCdp.emitAsync('Fetch.requestPaused', {
        requestId: 'req1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
        resourceType: 'Document',
        frameId: 'frame1',
        isNavigationRequest: true,
      });

      const call = mockCdp.findCall('Fetch.continueRequest');
      expect(call).toBeDefined();
      expect(call?.params).toMatchObject({ requestId: 'req1' });
    });

    test('should allow URL override', async () => {
      await interceptor.enable();

      interceptor.addHandler({ urlPattern: '*' }, async (_request, actions) => {
        await actions.continue({ url: 'https://other.com' });
      });

      await mockCdp.emitAsync('Fetch.requestPaused', {
        requestId: 'req1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
        resourceType: 'Document',
        frameId: 'frame1',
        isNavigationRequest: true,
      });

      const call = mockCdp.findCall('Fetch.continueRequest');
      expect(call?.params).toMatchObject({
        requestId: 'req1',
        url: 'https://other.com',
      });
    });

    test('should allow header override', async () => {
      await interceptor.enable();

      interceptor.addHandler({ urlPattern: '*' }, async (_request, actions) => {
        await actions.continue({
          headers: { Authorization: 'Bearer token123' },
        });
      });

      await mockCdp.emitAsync('Fetch.requestPaused', {
        requestId: 'req1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
        resourceType: 'Document',
        frameId: 'frame1',
        isNavigationRequest: true,
      });

      const call = mockCdp.findCall('Fetch.continueRequest');
      expect(call?.params).toMatchObject({
        requestId: 'req1',
        headers: [{ name: 'Authorization', value: 'Bearer token123' }],
      });
    });
  });

  describe('actions.fulfill()', () => {
    test('should send Fetch.fulfillRequest', async () => {
      await interceptor.enable();

      interceptor.addHandler({ urlPattern: '*' }, async (_request, actions) => {
        await actions.fulfill({
          status: 200,
          body: '{"ok":true}',
          headers: { 'content-type': 'application/json' },
        });
      });

      await mockCdp.emitAsync('Fetch.requestPaused', {
        requestId: 'req1',
        request: { url: 'https://example.com/api', method: 'GET', headers: {} },
        resourceType: 'XHR',
        frameId: 'frame1',
        isNavigationRequest: false,
      });

      const call = mockCdp.findCall('Fetch.fulfillRequest');
      expect(call).toBeDefined();
      expect(call?.params).toMatchObject({
        requestId: 'req1',
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      });
    });

    test('should encode body as base64', async () => {
      await interceptor.enable();

      interceptor.addHandler({ urlPattern: '*' }, async (_request, actions) => {
        await actions.fulfill({
          status: 200,
          body: 'Hello World',
        });
      });

      await mockCdp.emitAsync('Fetch.requestPaused', {
        requestId: 'req1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
        resourceType: 'Document',
        frameId: 'frame1',
        isNavigationRequest: true,
      });

      const call = mockCdp.findCall('Fetch.fulfillRequest');
      // btoa('Hello World') = 'SGVsbG8gV29ybGQ='
      expect(call?.params?.['body']).toBe('SGVsbG8gV29ybGQ=');
    });
  });

  describe('actions.fail()', () => {
    test('should send Fetch.failRequest with default reason', async () => {
      await interceptor.enable();

      interceptor.addHandler({ urlPattern: '*' }, async (_request, actions) => {
        await actions.fail();
      });

      await mockCdp.emitAsync('Fetch.requestPaused', {
        requestId: 'req1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
        resourceType: 'Document',
        frameId: 'frame1',
        isNavigationRequest: true,
      });

      const call = mockCdp.findCall('Fetch.failRequest');
      expect(call).toBeDefined();
      expect(call?.params).toMatchObject({
        requestId: 'req1',
        errorReason: 'BlockedByClient',
      });
    });

    test('should send custom error reason', async () => {
      await interceptor.enable();

      interceptor.addHandler({ urlPattern: '*' }, async (_request, actions) => {
        await actions.fail({ reason: 'ConnectionRefused' });
      });

      await mockCdp.emitAsync('Fetch.requestPaused', {
        requestId: 'req1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
        resourceType: 'Document',
        frameId: 'frame1',
        isNavigationRequest: true,
      });

      const call = mockCdp.findCall('Fetch.failRequest');
      expect(call?.params).toMatchObject({
        errorReason: 'ConnectionRefused',
      });
    });
  });

  describe('error handling', () => {
    test('should continue request if handler throws', async () => {
      await interceptor.enable();

      interceptor.addHandler({ urlPattern: '*' }, async () => {
        throw new Error('Handler error');
      });

      await mockCdp.emitAsync('Fetch.requestPaused', {
        requestId: 'req1',
        request: { url: 'https://example.com', method: 'GET', headers: {} },
        resourceType: 'Document',
        frameId: 'frame1',
        isNavigationRequest: true,
      });

      expect(mockCdp.findCall('Fetch.continueRequest')).toBeDefined();
    });
  });

  describe('auth handling', () => {
    test('should cancel auth by default', async () => {
      await interceptor.enable();

      await mockCdp.emitAsync('Fetch.authRequired', {
        requestId: 'req1',
        authChallenge: {
          source: 'Server',
          origin: 'https://example.com',
          scheme: 'Basic',
          realm: 'Example',
        },
      });

      const call = mockCdp.findCall('Fetch.continueWithAuth');
      expect(call).toBeDefined();
      expect(call?.params).toMatchObject({
        requestId: 'req1',
        authChallengeResponse: { response: 'CancelAuth' },
      });
    });
  });
});

describe('Page network interception methods', () => {
  // Create test page helper
  async function createTestPage(cdp: ReturnType<typeof createMockCDPClient>) {
    const { Page } = await import('../../src/browser/page.ts');
    return new Page(cdp as unknown as CDPClient);
  }

  describe('page.intercept()', () => {
    test('should lazy initialize interceptor', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);

      await page.intercept('*', async (_req, actions) => {
        await actions.continue();
      });

      expect(cdp.findCall('Fetch.enable')).toBeDefined();
    });

    test('should accept string pattern', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);

      let called = false;
      await page.intercept('*api*', async (_req, actions) => {
        called = true;
        await actions.continue();
      });

      await cdp.emitAsync('Fetch.requestPaused', {
        requestId: '1',
        request: { url: 'https://example.com/api/test', method: 'GET', headers: {} },
        resourceType: 'XHR',
        frameId: 'frame1',
        isNavigationRequest: false,
      });

      expect(called).toBe(true);
    });
  });

  describe('page.route()', () => {
    test('should fulfill with provided options', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);

      await page.route('*api*', {
        status: 200,
        body: { users: [] },
      });

      await cdp.emitAsync('Fetch.requestPaused', {
        requestId: '1',
        request: { url: 'https://example.com/api/users', method: 'GET', headers: {} },
        resourceType: 'XHR',
        frameId: 'frame1',
        isNavigationRequest: false,
      });

      const call = cdp.findCall('Fetch.fulfillRequest');
      expect(call).toBeDefined();
      expect(call?.params).toMatchObject({
        responseCode: 200,
      });
    });

    test('should auto-serialize object body to JSON', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);

      await page.route('*api*', {
        body: { message: 'hello' },
      });

      await cdp.emitAsync('Fetch.requestPaused', {
        requestId: '1',
        request: { url: 'https://example.com/api/test', method: 'GET', headers: {} },
        resourceType: 'XHR',
        frameId: 'frame1',
        isNavigationRequest: false,
      });

      const call = cdp.findCall('Fetch.fulfillRequest');
      expect(call?.params).toMatchObject({
        responseHeaders: expect.arrayContaining([
          { name: 'content-type', value: 'application/json' },
        ]),
      });
    });
  });

  describe('page.blockResources()', () => {
    test('should block specified resource types', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);

      await page.blockResources(['Image', 'Font']);

      // Image request should be blocked
      await cdp.emitAsync('Fetch.requestPaused', {
        requestId: '1',
        request: { url: 'https://example.com/photo.jpg', method: 'GET', headers: {} },
        resourceType: 'Image',
        frameId: 'frame1',
        isNavigationRequest: false,
      });

      expect(cdp.findCall('Fetch.failRequest')).toBeDefined();
    });

    test('should continue non-blocked resource types', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);

      await page.blockResources(['Image', 'Font']);

      // XHR request should continue
      await cdp.emitAsync('Fetch.requestPaused', {
        requestId: '1',
        request: { url: 'https://example.com/api/data', method: 'GET', headers: {} },
        resourceType: 'XHR',
        frameId: 'frame1',
        isNavigationRequest: false,
      });

      expect(cdp.findCall('Fetch.continueRequest')).toBeDefined();
      expect(cdp.findCall('Fetch.failRequest')).toBeUndefined();
    });
  });

  describe('page.disableInterception()', () => {
    test('should disable interceptor', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);

      await page.intercept('*', async (_req, actions) => {
        await actions.continue();
      });

      await page.disableInterception();

      expect(cdp.findCall('Fetch.disable')).toBeDefined();
    });

    test('should handle case when not enabled', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);

      // Should not throw
      await page.disableInterception();

      expect(cdp.findCall('Fetch.disable')).toBeUndefined();
    });
  });
});
