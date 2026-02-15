import { describe, expect, test } from 'bun:test';
import { generateTone, pcmToWav } from '../../src/audio/encoding.ts';
import { AudioInput } from '../../src/audio/input.ts';
import type { CDPClient } from '../../src/cdp/client.ts';

type CDPCall = { method: string; params?: Record<string, unknown> };

function createMockCDPClient() {
  const eventHandlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();

  return {
    sent: [] as CDPCall[],

    async send(method: string, params?: Record<string, unknown>) {
      this.sent.push({ method, params });
      return { result: { value: null } };
    },

    on(event: string, handler: (params: Record<string, unknown>) => void) {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, new Set());
      }
      eventHandlers.get(event)!.add(handler);
    },

    off(event: string, handler: (params: Record<string, unknown>) => void) {
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

  test('setup grants permissions, registers binding, and injects script', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    await input.setup();

    expect(input.isSetup).toBe(true);

    // Permissions
    const permCall = cdp.findCall('Browser.grantPermissions');
    expect(permCall).toBeDefined();
    expect(permCall!.params!['permissions']).toEqual(['audioCapture']);

    // Binding
    const bindingCalls = cdp.findAllCalls('Runtime.addBinding');
    expect(bindingCalls.find((c) => c.params!['name'] === '__bpAudioInputDone')).toBeDefined();

    // Script injection (both persistent and immediate)
    const scriptCalls = cdp.findAllCalls('Page.addScriptToEvaluateOnNewDocument');
    const inputScript = scriptCalls.find((c) =>
      (c.params!['source'] as string).includes('__bpAudioInput')
    );
    expect(inputScript).toBeDefined();
    expect(inputScript!.params!['source']).toContain('getUserMedia');
    expect(inputScript!.params!['source']).toContain('enumerateDevices');

    const evalCalls = cdp.findAllCalls('Runtime.evaluate');
    const inputEval = evalCalls.find((c) =>
      (c.params!['expression'] as string).includes('__bpAudioInput')
    );
    expect(inputEval).toBeDefined();
  });

  test('setup is idempotent', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    await input.setup();
    const countAfterFirst = cdp.sent.length;

    await input.setup();
    expect(cdp.sent.length).toBe(countAfterFirst);
  });

  test('play auto-sets up if not already set up', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    expect(input.isSetup).toBe(false);

    const wav = pcmToWav({ left: generateTone(440, 100), sampleRate: 48000 });
    await input.play(wav, { waitForEnd: false });

    expect(input.isSetup).toBe(true);
  });

  test('play with waitForEnd=false sends base64 audio to page', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    await input.setup();

    const wav = pcmToWav({ left: generateTone(440, 100), sampleRate: 48000 });
    await input.play(wav, { waitForEnd: false });

    const evalCalls = cdp.findAllCalls('Runtime.evaluate');
    const playCall = evalCalls.find((c) =>
      (c.params!['expression'] as string).includes('__bpAudioInput.play(')
    );
    expect(playCall).toBeDefined();
    const expr = playCall!.params!['expression'] as string;
    const b64Match = expr.match(/play\('(.+)'\)/);
    expect(b64Match).toBeDefined();
    expect(b64Match![1]!.length).toBeGreaterThan(10);
  });

  test('play with waitForEnd=true waits for binding callback', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    await input.setup();

    const wav = pcmToWav({ left: generateTone(440, 100), sampleRate: 48000 });

    // Simulate the binding firing shortly after play starts
    const playPromise = input.play(wav, { waitForEnd: true, timeout: 5000 });

    // Give the play command time to register the listener and send the evaluate
    await new Promise((r) => setTimeout(r, 10));

    cdp.emit('Runtime.bindingCalled', { name: '__bpAudioInputDone', payload: 'done' });

    // Should resolve without timeout
    await playPromise;
  });

  test('play with waitForEnd=true times out if binding never fires', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    await input.setup();

    const wav = pcmToWav({ left: generateTone(440, 100), sampleRate: 48000 });

    await expect(input.play(wav, { waitForEnd: true, timeout: 50 })).rejects.toThrow('timed out');
  });

  test('stop sends stop command', async () => {
    const cdp = createMockCDPClient();
    const input = new AudioInput(cdp as unknown as CDPClient);
    await input.setup();
    await input.stop();

    const evalCalls = cdp.findAllCalls('Runtime.evaluate');
    const stopCall = evalCalls.find((c) => (c.params!['expression'] as string).includes('.stop'));
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
