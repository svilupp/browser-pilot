/**
 * Unit tests for AudioInput
 */

import { describe, expect, test } from 'bun:test';
import { generateTone, pcmToWav } from '../../src/audio/encoding.ts';
import { AudioInput } from '../../src/audio/input.ts';
import type { CDPClient } from '../../src/cdp/client.ts';

type CDPCall = { method: string; params?: Record<string, unknown> };
type EventHandler = (params: Record<string, unknown>) => void;

function createMockCDPClient() {
  const eventHandlers = new Map<string, Set<EventHandler>>();

  return {
    sent: [] as CDPCall[],

    async send(method: string, params?: Record<string, unknown>) {
      this.sent.push({ method, params });
      return { result: { value: null } };
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
      for (const h of eventHandlers.get(event) ?? []) h(params);
    },

    findCall(method: string): CDPCall | undefined {
      return this.sent.find((c) => c.method === method);
    },

    findAllCalls(method: string): CDPCall[] {
      return this.sent.filter((c) => c.method === method);
    },
  };
}

describe('AudioInput', () => {
  test('isSetup is false before setup', () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    expect(input.isSetup).toBe(false);
  });

  test('setup grants permissions', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    await input.setup();

    const call = cdp.findCall('Browser.grantPermissions');
    expect(call).toBeDefined();
    expect(call!.params!['permissions']).toEqual(['audioCapture']);
  });

  test('setup registers binding', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    await input.setup();

    const bindingCalls = cdp.findAllCalls('Runtime.addBinding');
    const inputBinding = bindingCalls.find((c) => c.params!['name'] === '__bpAudioInputDone');
    expect(inputBinding).toBeDefined();
  });

  test('setup injects getUserMedia override script', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    await input.setup();

    const scriptCalls = cdp.findAllCalls('Page.addScriptToEvaluateOnNewDocument');
    // Should have permissions override + input override
    const inputScript = scriptCalls.find((c) =>
      (c.params!['source'] as string).includes('__bpAudioInput')
    );
    expect(inputScript).toBeDefined();
    expect(inputScript!.params!['source']).toContain('getUserMedia');
    expect(inputScript!.params!['source']).toContain('enumerateDevices');
  });

  test('setup also evaluates script in current page', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    await input.setup();

    const evalCalls = cdp.findAllCalls('Runtime.evaluate');
    const inputEval = evalCalls.find((c) =>
      (c.params!['expression'] as string).includes('__bpAudioInput')
    );
    expect(inputEval).toBeDefined();
  });

  test('isSetup is true after setup', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    await input.setup();
    expect(input.isSetup).toBe(true);
  });

  test('setup is idempotent', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    await input.setup();
    const countAfterFirst = cdp.sent.length;

    await input.setup();
    expect(cdp.sent.length).toBe(countAfterFirst); // no new calls
  });

  test('play throws if not set up', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    const wav = pcmToWav({ left: generateTone(440, 100), sampleRate: 48000 });

    await expect(input.play(wav)).rejects.toThrow('not set up');
  });

  test('play with waitForEnd=false sends evaluate and returns', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    await input.setup();

    const wav = pcmToWav({ left: generateTone(440, 100), sampleRate: 48000 });
    await input.play(wav, { waitForEnd: false });

    const evalCalls = cdp.findAllCalls('Runtime.evaluate');
    const playCalls = evalCalls.filter((c) =>
      (c.params!['expression'] as string).includes('__bpAudioInput.play(')
    );
    expect(playCalls.length).toBe(1);
  });

  test('play sends base64 encoded audio data', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    await input.setup();

    const wav = pcmToWav({ left: generateTone(440, 100), sampleRate: 48000 });
    await input.play(wav, { waitForEnd: false });

    const evalCalls = cdp.findAllCalls('Runtime.evaluate');
    const playCall = evalCalls.find((c) =>
      (c.params!['expression'] as string).includes('__bpAudioInput.play(')
    );
    // Should contain base64 data between quotes
    const expr = playCall!.params!['expression'] as string;
    expect(expr).toContain("__bpAudioInput.play('");
    // Base64 data should be non-empty
    const b64Match = expr.match(/play\('(.+)'\)/);
    expect(b64Match).toBeDefined();
    expect(b64Match![1]!.length).toBeGreaterThan(10);
  });

  test('stop sends stop command', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    await input.setup();
    await input.stop();

    const evalCalls = cdp.findAllCalls('Runtime.evaluate');
    const stopCall = evalCalls.find(
      (c) =>
        (c.params!['expression'] as string).includes('__bpAudioInput') &&
        (c.params!['expression'] as string).includes('stop')
    );
    expect(stopCall).toBeDefined();
  });

  test('getState returns default when not set up', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    const state = await input.getState();
    expect(state.contextState).toBe('not-created');
    expect(state.isPlaying).toBe(false);
    expect(state.sampleRate).toBe(0);
  });

  test('teardown resets state', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    await input.setup();
    expect(input.isSetup).toBe(true);

    await input.teardown();
    expect(input.isSetup).toBe(false);
  });
});
