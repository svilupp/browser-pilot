/**
 * Unit tests for Emulation features
 */

import { describe, expect, test } from 'bun:test';
import type { CDPClient } from '../../src/cdp/client.ts';
import { devices } from '../../src/emulation/index.ts';

// Create a mock CDP client for testing
type CDPCall = { method: string; params?: Record<string, unknown> };
type EventHandler = (params: Record<string, unknown>) => void;

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
      eventHandlers.get(event)?.forEach((h) => {
        h(params);
      });
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
  };
}

// Minimal Page class implementation for testing emulation methods
async function createTestPage(cdp: ReturnType<typeof createMockCDPClient>) {
  // Dynamically import to avoid circular dependency issues
  const { Page } = await import('../../src/browser/page.ts');
  return new Page(cdp as unknown as CDPClient);
}

describe('Device Presets', () => {
  test('should have iPhone 14 preset', () => {
    const device = devices['iPhone 14']!;

    expect(device).toBeDefined();
    expect(device.name).toBe('iPhone 14');
    expect(device.viewport.width).toBe(390);
    expect(device.viewport.height).toBe(844);
    expect(device.viewport.isMobile).toBe(true);
    expect(device.viewport.hasTouch).toBe(true);
    expect(device.userAgent.userAgent).toContain('iPhone');
  });

  test('should have Pixel 7 preset', () => {
    const device = devices['Pixel 7']!;

    expect(device).toBeDefined();
    expect(device.name).toBe('Pixel 7');
    expect(device.viewport.width).toBe(412);
    expect(device.viewport.isMobile).toBe(true);
    expect(device.userAgent.userAgent).toContain('Android');
  });

  test('should have Desktop Chrome preset', () => {
    const device = devices['Desktop Chrome']!;

    expect(device).toBeDefined();
    expect(device.viewport.width).toBe(1920);
    expect(device.viewport.height).toBe(1080);
    expect(device.viewport.isMobile).toBe(false);
    expect(device.viewport.hasTouch).toBe(false);
    expect(device.userAgent.userAgent).toContain('Chrome');
  });

  test('should have all expected device presets', () => {
    const expectedDevices = [
      'iPhone 14',
      'iPhone 14 Pro Max',
      'Pixel 7',
      'iPad Pro 11',
      'Desktop Chrome',
      'Desktop Firefox',
    ];

    for (const name of expectedDevices) {
      const device = devices[name];
      expect(device).toBeDefined();
      expect(device!.name).toBe(name);
    }
  });
});

describe('Page.setViewport', () => {
  test('should send Emulation.setDeviceMetricsOverride with correct params', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.setViewport({ width: 1280, height: 720 });

    const call = cdp.findCall('Emulation.setDeviceMetricsOverride');
    expect(call).toBeDefined();
    expect(call?.params).toMatchObject({
      width: 1280,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: 1280,
      screenHeight: 720,
    });
  });

  test('should apply default values correctly', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.setViewport({ width: 800, height: 600 });

    const call = cdp.findCall('Emulation.setDeviceMetricsOverride');
    expect(call?.params).toMatchObject({
      deviceScaleFactor: 1,
      mobile: false,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
  });

  test('should enable touch emulation when hasTouch is true', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.setViewport({ width: 375, height: 812, hasTouch: true });

    const touchCall = cdp.findCall('Emulation.setTouchEmulationEnabled');
    expect(touchCall).toBeDefined();
    expect(touchCall?.params).toMatchObject({
      enabled: true,
      maxTouchPoints: 5,
    });
  });

  test('should set landscape orientation when isLandscape is true', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.setViewport({ width: 812, height: 375, isLandscape: true });

    const call = cdp.findCall('Emulation.setDeviceMetricsOverride');
    expect(call?.params).toMatchObject({
      screenOrientation: { type: 'landscapePrimary', angle: 90 },
    });
  });

  test('should update emulation state', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.setViewport({ width: 1024, height: 768 });

    const state = page.getEmulationState();
    expect(state.viewport).toMatchObject({
      width: 1024,
      height: 768,
    });
  });
});

describe('Page.clearViewport', () => {
  test('should clear device metrics and touch emulation', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.setViewport({ width: 800, height: 600 });
    await page.clearViewport();

    expect(cdp.findCall('Emulation.clearDeviceMetricsOverride')).toBeDefined();
    const touchCall = cdp.findAllCalls('Emulation.setTouchEmulationEnabled').pop();
    expect(touchCall?.params).toMatchObject({ enabled: false });
  });

  test('should clear emulation state', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.setViewport({ width: 800, height: 600 });
    await page.clearViewport();

    const state = page.getEmulationState();
    expect(state.viewport).toBeUndefined();
  });
});

describe('Page.setUserAgent', () => {
  test('should handle string input', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.setUserAgent('Custom User Agent String');

    const call = cdp.findCall('Emulation.setUserAgentOverride');
    expect(call).toBeDefined();
    expect(call?.params).toMatchObject({
      userAgent: 'Custom User Agent String',
    });
  });

  test('should handle object input with all options', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.setUserAgent({
      userAgent: 'Mozilla/5.0 Test',
      acceptLanguage: 'en-US,en;q=0.9',
      platform: 'Win32',
      userAgentMetadata: {
        platform: 'Windows',
        mobile: false,
      },
    });

    const call = cdp.findCall('Emulation.setUserAgentOverride');
    expect(call?.params).toMatchObject({
      userAgent: 'Mozilla/5.0 Test',
      acceptLanguage: 'en-US,en;q=0.9',
      platform: 'Win32',
      userAgentMetadata: {
        platform: 'Windows',
        mobile: false,
      },
    });
  });

  test('should update emulation state', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.setUserAgent('Test UA');

    const state = page.getEmulationState();
    expect(state.userAgent).toMatchObject({
      userAgent: 'Test UA',
    });
  });
});

describe('Page.setGeolocation', () => {
  test('should grant permission and set geolocation', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.setGeolocation({ latitude: 37.7749, longitude: -122.4194 });

    // Check permission was granted
    const permCall = cdp.findCall('Browser.grantPermissions');
    expect(permCall).toBeDefined();
    expect(permCall?.params).toMatchObject({
      permissions: ['geolocation'],
    });

    // Check geolocation was set
    const geoCall = cdp.findCall('Emulation.setGeolocationOverride');
    expect(geoCall).toBeDefined();
    expect(geoCall?.params).toMatchObject({
      latitude: 37.7749,
      longitude: -122.4194,
      accuracy: 1,
    });
  });

  test('should use custom accuracy', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.setGeolocation({ latitude: 40.7128, longitude: -74.006, accuracy: 100 });

    const call = cdp.findCall('Emulation.setGeolocationOverride');
    expect(call?.params).toMatchObject({
      accuracy: 100,
    });
  });

  test('should update emulation state', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.setGeolocation({ latitude: 51.5074, longitude: -0.1278 });

    const state = page.getEmulationState();
    expect(state.geolocation).toMatchObject({
      latitude: 51.5074,
      longitude: -0.1278,
    });
  });
});

describe('Page.clearGeolocation', () => {
  test('should clear geolocation override', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.setGeolocation({ latitude: 0, longitude: 0 });
    await page.clearGeolocation();

    expect(cdp.findCall('Emulation.clearGeolocationOverride')).toBeDefined();

    const state = page.getEmulationState();
    expect(state.geolocation).toBeUndefined();
  });
});

describe('Page.setTimezone', () => {
  test('should set timezone override', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.setTimezone('America/New_York');

    const call = cdp.findCall('Emulation.setTimezoneOverride');
    expect(call).toBeDefined();
    expect(call?.params).toMatchObject({
      timezoneId: 'America/New_York',
    });

    const state = page.getEmulationState();
    expect(state.timezone).toBe('America/New_York');
  });
});

describe('Page.setLocale', () => {
  test('should set locale override', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.setLocale('fr-FR');

    const call = cdp.findCall('Emulation.setLocaleOverride');
    expect(call).toBeDefined();
    expect(call?.params).toMatchObject({
      locale: 'fr-FR',
    });

    const state = page.getEmulationState();
    expect(state.locale).toBe('fr-FR');
  });
});

describe('Page.emulate', () => {
  test('should apply device viewport and user agent', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.emulate(devices['iPhone 14']!);

    // Check viewport was set
    const viewportCall = cdp.findCall('Emulation.setDeviceMetricsOverride');
    expect(viewportCall).toBeDefined();
    expect(viewportCall?.params).toMatchObject({
      width: 390,
      height: 844,
      mobile: true,
    });

    // Check user agent was set
    const uaCall = cdp.findCall('Emulation.setUserAgentOverride');
    expect(uaCall).toBeDefined();
    expect(uaCall?.params?.['userAgent']).toContain('iPhone');
  });

  test('should enable touch for mobile devices', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.emulate(devices['Pixel 7']!);

    const touchCall = cdp.findCall('Emulation.setTouchEmulationEnabled');
    expect(touchCall).toBeDefined();
    expect(touchCall?.params).toMatchObject({
      enabled: true,
    });
  });
});

describe('Page.getEmulationState', () => {
  test('should return empty state initially', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    const state = page.getEmulationState();
    expect(state).toEqual({});
  });

  test('should return a copy of the state (immutable)', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);

    await page.setViewport({ width: 800, height: 600 });

    const state1 = page.getEmulationState();
    const state2 = page.getEmulationState();

    expect(state1).not.toBe(state2);
    expect(state1).toEqual(state2);
  });
});
