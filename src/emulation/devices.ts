/**
 * Device presets for common emulation scenarios
 */

import type { UserAgentOptions, ViewportOptions } from '../browser/types.ts';

export interface DeviceDescriptor {
  name: string;
  viewport: ViewportOptions;
  userAgent: UserAgentOptions;
}

export const devices: Record<string, DeviceDescriptor> = {
  'iPhone 14': {
    name: 'iPhone 14',
    viewport: {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
    userAgent: {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      userAgentMetadata: {
        mobile: true,
        platform: 'iOS',
        platformVersion: '16.0',
      },
    },
  },
  'iPhone 14 Pro Max': {
    name: 'iPhone 14 Pro Max',
    viewport: {
      width: 430,
      height: 932,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    },
    userAgent: {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
    },
  },
  'Pixel 7': {
    name: 'Pixel 7',
    viewport: {
      width: 412,
      height: 915,
      deviceScaleFactor: 2.625,
      isMobile: true,
      hasTouch: true,
    },
    userAgent: {
      userAgent:
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      platform: 'Linux armv8l',
      userAgentMetadata: {
        mobile: true,
        platform: 'Android',
        platformVersion: '13',
        model: 'Pixel 7',
      },
    },
  },
  'iPad Pro 11': {
    name: 'iPad Pro 11',
    viewport: {
      width: 834,
      height: 1194,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    },
    userAgent: {
      userAgent:
        'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      platform: 'iPad',
    },
  },
  'Desktop Chrome': {
    name: 'Desktop Chrome',
    viewport: {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    },
    userAgent: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      platform: 'Win32',
      userAgentMetadata: {
        brands: [
          { brand: 'Not_A Brand', version: '8' },
          { brand: 'Chromium', version: '120' },
          { brand: 'Google Chrome', version: '120' },
        ],
        platform: 'Windows',
        platformVersion: '10.0.0',
        architecture: 'x86',
        bitness: '64',
        mobile: false,
      },
    },
  },
  'Desktop Firefox': {
    name: 'Desktop Firefox',
    viewport: {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    },
    userAgent: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      platform: 'Win32',
    },
  },
};

export type DeviceName = keyof typeof devices;
