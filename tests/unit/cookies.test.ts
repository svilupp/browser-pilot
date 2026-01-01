/**
 * Unit tests for Cookie Management
 */

import { describe, expect, test } from 'bun:test';

// Create a mock CDP client for testing
function createMockCDPClient() {
  const responses = new Map<string, unknown>();
  const eventHandlers = new Map<string, Set<(params: unknown) => void>>();

  return {
    sent: [] as Array<{ method: string; params?: unknown }>,

    async send(method: string, params?: unknown) {
      this.sent.push({ method, params });

      if (responses.has(method)) {
        return responses.get(method);
      }

      // Default responses
      if (method === 'Runtime.evaluate') {
        return { result: { value: null } };
      }
      if (method === 'Network.getCookies') {
        return { cookies: [] };
      }
      if (method === 'Network.setCookie') {
        return { success: true };
      }

      return {};
    },

    on(event: string, handler: (params: unknown) => void) {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, new Set());
      }
      eventHandlers.get(event)!.add(handler);
    },

    off(event: string, handler: (params: unknown) => void) {
      eventHandlers.get(event)?.delete(handler);
    },

    mockResponse(method: string, response: unknown) {
      responses.set(method, response);
    },

    findCall(method: string) {
      return this.sent.find((c) => c.method === method);
    },

    findAllCalls(method: string) {
      return this.sent.filter((c) => c.method === method);
    },

    clear() {
      this.sent = [];
    },
  };
}

// Create test page helper
async function createTestPage(cdp: ReturnType<typeof createMockCDPClient>) {
  const { Page } = await import('../../src/browser/page.ts');
  return new Page(cdp as any);
}

describe('Cookie Management', () => {
  describe('page.cookies()', () => {
    test('should get cookies for current page URL', async () => {
      const cdp = createMockCDPClient();
      cdp.mockResponse('Runtime.evaluate', { result: { value: 'https://example.com' } });
      cdp.mockResponse('Network.getCookies', {
        cookies: [{ name: 'session', value: 'abc123', domain: '.example.com', path: '/' }],
      });

      const page = await createTestPage(cdp);
      const cookies = await page.cookies();

      expect(cookies).toHaveLength(1);
      expect(cookies[0]!.name).toBe('session');
      expect(cookies[0]!.value).toBe('abc123');
    });

    test('should get cookies for specified URLs', async () => {
      const cdp = createMockCDPClient();
      cdp.mockResponse('Network.getCookies', { cookies: [] });

      const page = await createTestPage(cdp);
      await page.cookies(['https://example.com', 'https://other.com']);

      const call = cdp.findCall('Network.getCookies');
      expect(call?.params).toMatchObject({
        urls: ['https://example.com', 'https://other.com'],
      });
    });
  });

  describe('page.setCookie()', () => {
    test('should set a basic cookie', async () => {
      const cdp = createMockCDPClient();
      cdp.mockResponse('Runtime.evaluate', { result: { value: 'https://example.com' } });
      cdp.mockResponse('Network.setCookie', { success: true });

      const page = await createTestPage(cdp);
      const result = await page.setCookie({
        name: 'token',
        value: 'xyz123',
      });

      expect(result).toBe(true);
      const call = cdp.findCall('Network.setCookie');
      expect(call?.params).toMatchObject({
        name: 'token',
        value: 'xyz123',
        path: '/',
      });
    });

    test('should set cookie with domain', async () => {
      const cdp = createMockCDPClient();
      cdp.mockResponse('Network.setCookie', { success: true });

      const page = await createTestPage(cdp);
      await page.setCookie({
        name: 'token',
        value: 'xyz',
        domain: '.example.com',
      });

      const call = cdp.findCall('Network.setCookie');
      expect(call?.params).toMatchObject({
        domain: '.example.com',
        url: undefined,
      });
    });

    test('should handle Date expiration', async () => {
      const cdp = createMockCDPClient();
      cdp.mockResponse('Network.setCookie', { success: true });

      const page = await createTestPage(cdp);
      const expiryDate = new Date('2025-12-31T00:00:00Z');

      await page.setCookie({
        name: 'token',
        value: 'xyz',
        domain: '.example.com',
        expires: expiryDate,
      });

      const call = cdp.findCall('Network.setCookie');
      expect((call?.params as any)?.expires).toBe(Math.floor(expiryDate.getTime() / 1000));
    });

    test('should handle numeric expiration', async () => {
      const cdp = createMockCDPClient();
      cdp.mockResponse('Network.setCookie', { success: true });

      const page = await createTestPage(cdp);

      await page.setCookie({
        name: 'token',
        value: 'xyz',
        domain: '.example.com',
        expires: 1735689600,
      });

      const call = cdp.findCall('Network.setCookie');
      expect((call?.params as any)?.expires).toBe(1735689600);
    });

    test('should set cookie with all options', async () => {
      const cdp = createMockCDPClient();
      cdp.mockResponse('Network.setCookie', { success: true });

      const page = await createTestPage(cdp);
      await page.setCookie({
        name: 'secure_token',
        value: 'secret',
        domain: '.example.com',
        path: '/api',
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
      });

      const call = cdp.findCall('Network.setCookie');
      expect(call?.params).toMatchObject({
        name: 'secure_token',
        value: 'secret',
        domain: '.example.com',
        path: '/api',
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
      });
    });
  });

  describe('page.setCookies()', () => {
    test('should set multiple cookies', async () => {
      const cdp = createMockCDPClient();
      cdp.mockResponse('Network.setCookie', { success: true });

      const page = await createTestPage(cdp);
      await page.setCookies([
        { name: 'cookie1', value: 'value1', domain: '.example.com' },
        { name: 'cookie2', value: 'value2', domain: '.example.com' },
      ]);

      const calls = cdp.findAllCalls('Network.setCookie');
      expect(calls).toHaveLength(2);
    });
  });

  describe('page.deleteCookie()', () => {
    test('should delete a cookie by name', async () => {
      const cdp = createMockCDPClient();
      cdp.mockResponse('Runtime.evaluate', { result: { value: 'https://example.com' } });

      const page = await createTestPage(cdp);
      await page.deleteCookie({ name: 'session' });

      const call = cdp.findCall('Network.deleteCookies');
      expect(call).toBeDefined();
      expect(call?.params).toMatchObject({
        name: 'session',
      });
    });

    test('should delete cookie with domain and path', async () => {
      const cdp = createMockCDPClient();

      const page = await createTestPage(cdp);
      await page.deleteCookie({
        name: 'session',
        domain: '.example.com',
        path: '/app',
      });

      const call = cdp.findCall('Network.deleteCookies');
      expect(call?.params).toMatchObject({
        name: 'session',
        domain: '.example.com',
        path: '/app',
      });
    });
  });

  describe('page.deleteCookies()', () => {
    test('should delete multiple cookies', async () => {
      const cdp = createMockCDPClient();

      const page = await createTestPage(cdp);
      await page.deleteCookies([
        { name: 'cookie1', domain: '.example.com' },
        { name: 'cookie2', domain: '.example.com' },
      ]);

      const calls = cdp.findAllCalls('Network.deleteCookies');
      expect(calls).toHaveLength(2);
    });
  });

  describe('page.clearCookies()', () => {
    test('should clear all cookies', async () => {
      const cdp = createMockCDPClient();

      const page = await createTestPage(cdp);
      await page.clearCookies();

      const call = cdp.findCall('Storage.clearCookies');
      expect(call).toBeDefined();
    });

    test('should clear cookies for specific domain', async () => {
      const cdp = createMockCDPClient();
      cdp.mockResponse('Network.getCookies', {
        cookies: [
          { name: 'session', value: 'abc', domain: '.example.com', path: '/' },
          { name: 'token', value: 'xyz', domain: '.example.com', path: '/api' },
        ],
      });

      const page = await createTestPage(cdp);
      await page.clearCookies({ domain: 'example.com' });

      // Should get cookies for domain
      const getCookies = cdp.findCall('Network.getCookies');
      expect(getCookies?.params).toMatchObject({
        urls: ['https://example.com'],
      });

      // Should delete each cookie
      const deleteCalls = cdp.findAllCalls('Network.deleteCookies');
      expect(deleteCalls).toHaveLength(2);
    });
  });
});

describe('LocalStorage', () => {
  describe('page.getLocalStorage()', () => {
    test('should get localStorage value', async () => {
      const cdp = createMockCDPClient();
      cdp.mockResponse('Runtime.evaluate', { result: { value: 'stored-value' } });

      const page = await createTestPage(cdp);
      const value = await page.getLocalStorage('myKey');

      expect(value).toBe('stored-value');
      const call = cdp.findCall('Runtime.evaluate');
      expect((call?.params as any)?.expression).toContain('localStorage.getItem');
      expect((call?.params as any)?.expression).toContain('myKey');
    });

    test('should return null for non-existent key', async () => {
      const cdp = createMockCDPClient();
      cdp.mockResponse('Runtime.evaluate', { result: { value: null } });

      const page = await createTestPage(cdp);
      const value = await page.getLocalStorage('nonExistent');

      expect(value).toBeNull();
    });
  });

  describe('page.setLocalStorage()', () => {
    test('should set localStorage value', async () => {
      const cdp = createMockCDPClient();

      const page = await createTestPage(cdp);
      await page.setLocalStorage('myKey', 'myValue');

      const call = cdp.findCall('Runtime.evaluate');
      expect((call?.params as any)?.expression).toContain('localStorage.setItem');
      expect((call?.params as any)?.expression).toContain('myKey');
      expect((call?.params as any)?.expression).toContain('myValue');
    });
  });

  describe('page.removeLocalStorage()', () => {
    test('should remove localStorage item', async () => {
      const cdp = createMockCDPClient();

      const page = await createTestPage(cdp);
      await page.removeLocalStorage('myKey');

      const call = cdp.findCall('Runtime.evaluate');
      expect((call?.params as any)?.expression).toContain('localStorage.removeItem');
      expect((call?.params as any)?.expression).toContain('myKey');
    });
  });

  describe('page.clearLocalStorage()', () => {
    test('should clear localStorage', async () => {
      const cdp = createMockCDPClient();

      const page = await createTestPage(cdp);
      await page.clearLocalStorage();

      const call = cdp.findCall('Runtime.evaluate');
      expect((call?.params as any)?.expression).toBe('localStorage.clear()');
    });
  });
});

describe('SessionStorage', () => {
  describe('page.getSessionStorage()', () => {
    test('should get sessionStorage value', async () => {
      const cdp = createMockCDPClient();
      cdp.mockResponse('Runtime.evaluate', { result: { value: 'session-data' } });

      const page = await createTestPage(cdp);
      const value = await page.getSessionStorage('sessionKey');

      expect(value).toBe('session-data');
      const call = cdp.findCall('Runtime.evaluate');
      expect((call?.params as any)?.expression).toContain('sessionStorage.getItem');
    });
  });

  describe('page.setSessionStorage()', () => {
    test('should set sessionStorage value', async () => {
      const cdp = createMockCDPClient();

      const page = await createTestPage(cdp);
      await page.setSessionStorage('sessionKey', 'sessionValue');

      const call = cdp.findCall('Runtime.evaluate');
      expect((call?.params as any)?.expression).toContain('sessionStorage.setItem');
    });
  });

  describe('page.removeSessionStorage()', () => {
    test('should remove sessionStorage item', async () => {
      const cdp = createMockCDPClient();

      const page = await createTestPage(cdp);
      await page.removeSessionStorage('sessionKey');

      const call = cdp.findCall('Runtime.evaluate');
      expect((call?.params as any)?.expression).toContain('sessionStorage.removeItem');
    });
  });

  describe('page.clearSessionStorage()', () => {
    test('should clear sessionStorage', async () => {
      const cdp = createMockCDPClient();

      const page = await createTestPage(cdp);
      await page.clearSessionStorage();

      const call = cdp.findCall('Runtime.evaluate');
      expect((call?.params as any)?.expression).toBe('sessionStorage.clear()');
    });
  });
});
