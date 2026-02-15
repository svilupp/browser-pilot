import { describe, expect, test } from 'bun:test';
import { grantAudioPermissions } from '../../src/audio/permissions.ts';
import type { CDPClient } from '../../src/cdp/client.ts';

type CDPCall = { method: string; params?: Record<string, unknown> };

function createMockCDPClient() {
  return {
    sent: [] as CDPCall[],

    async send(method: string, params?: Record<string, unknown>) {
      this.sent.push({ method, params });
      return {};
    },

    on() {},
    off() {},
  };
}

describe('grantAudioPermissions', () => {
  test('grants permissions and injects override in correct order', async () => {
    const cdp = createMockCDPClient();
    await grantAudioPermissions(cdp as unknown as CDPClient);

    expect(cdp.sent.length).toBe(2);

    // First: CDP permission grant
    expect(cdp.sent[0]!.method).toBe('Browser.grantPermissions');
    expect(cdp.sent[0]!.params).toEqual({
      permissions: ['audioCapture'],
      origin: '',
    });

    // Second: JS permissions.query override
    expect(cdp.sent[1]!.method).toBe('Page.addScriptToEvaluateOnNewDocument');
    const script = cdp.sent[1]!.params!['source'] as string;
    expect(script).toContain('permissions.query');
    expect(script).toContain('microphone');
    expect(script).toContain("state: 'granted'");
  });

  test('passes custom origin to CDP permission grant', async () => {
    const cdp = createMockCDPClient();
    await grantAudioPermissions(cdp as unknown as CDPClient, 'https://example.com');

    expect(cdp.sent[0]!.params!['origin']).toBe('https://example.com');
  });
});
