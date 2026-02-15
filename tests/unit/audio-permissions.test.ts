/**
 * Unit tests for audio permission handling
 */

import { describe, expect, test } from 'bun:test';
import { grantAudioPermissions } from '../../src/audio/permissions.ts';
import type { CDPClient } from '../../src/cdp/client.ts';

type CDPCall = { method: string; params?: Record<string, unknown> };
type EventHandler = (params: Record<string, unknown>) => void;

function createMockCDPClient() {
  const eventHandlers = new Map<string, Set<EventHandler>>();

  return {
    sent: [] as CDPCall[],

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

    findCall(method: string): CDPCall | undefined {
      return this.sent.find((c) => c.method === method);
    },

    findAllCalls(method: string): CDPCall[] {
      return this.sent.filter((c) => c.method === method);
    },
  };
}

describe('grantAudioPermissions', () => {
  test('calls Browser.grantPermissions with audioCapture', async () => {
    const cdp = createMockCDPClient();
    await grantAudioPermissions(cdp as unknown as CDPClient);

    const call = cdp.findCall('Browser.grantPermissions');
    expect(call).toBeDefined();
    expect(call!.params).toEqual({
      permissions: ['audioCapture'],
      origin: '',
    });
  });

  test('passes custom origin', async () => {
    const cdp = createMockCDPClient();
    await grantAudioPermissions(cdp as unknown as CDPClient, 'https://example.com');

    const call = cdp.findCall('Browser.grantPermissions');
    expect(call!.params!['origin']).toBe('https://example.com');
  });

  test('injects permissions.query override script', async () => {
    const cdp = createMockCDPClient();
    await grantAudioPermissions(cdp as unknown as CDPClient);

    const call = cdp.findCall('Page.addScriptToEvaluateOnNewDocument');
    expect(call).toBeDefined();
    expect(call!.params!['source']).toContain('permissions.query');
    expect(call!.params!['source']).toContain('microphone');
    expect(call!.params!['source']).toContain('granted');
  });

  test('sends both CDP commands', async () => {
    const cdp = createMockCDPClient();
    await grantAudioPermissions(cdp as unknown as CDPClient);

    expect(cdp.sent.length).toBe(2);
    expect(cdp.sent[0]!.method).toBe('Browser.grantPermissions');
    expect(cdp.sent[1]!.method).toBe('Page.addScriptToEvaluateOnNewDocument');
  });
});
