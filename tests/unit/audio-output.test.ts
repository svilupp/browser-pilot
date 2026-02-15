import { describe, expect, test } from 'bun:test';
import { bufferToBase64 } from '../../src/audio/encoding.ts';
import { AudioOutput } from '../../src/audio/output.ts';
import type { CDPClient } from '../../src/cdp/client.ts';

type CDPCall = { method: string; params?: Record<string, unknown> };

function createMockCDPClient() {
  const eventHandlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();

  return {
    sent: [] as CDPCall[],

    async send(method: string, params?: Record<string, unknown>) {
      this.sent.push({ method, params });
      return {};
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

function createFakeAudioPayload(samples: number, amplitude: number): string {
  const left = new Float32Array(samples);
  const right = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    left[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / 48000);
    right[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / 48000);
  }

  const leftB64 = bufferToBase64(new Uint8Array(left.buffer));
  const rightB64 = bufferToBase64(new Uint8Array(right.buffer));

  return JSON.stringify({
    left: leftB64,
    right: rightB64,
    sampleRate: 48000,
    samples,
  });
}

describe('AudioOutput', () => {
  test('initial state is not set up and not capturing', () => {
    const cdp = createMockCDPClient();
    const output = new AudioOutput(cdp as unknown as CDPClient);
    expect(output.isSetup).toBe(false);
    expect(output.isCapturing).toBe(false);
  });

  test('setup registers binding, injects script, and evaluates in current page', async () => {
    const cdp = createMockCDPClient();
    const output = new AudioOutput(cdp as unknown as CDPClient);
    await output.setup();

    expect(output.isSetup).toBe(true);

    // Binding
    const bindingCall = cdp
      .findAllCalls('Runtime.addBinding')
      .find((c) => c.params!['name'] === '__bpAudioOutputData');
    expect(bindingCall).toBeDefined();

    // Script injection
    const scriptCall = cdp
      .findAllCalls('Page.addScriptToEvaluateOnNewDocument')
      .find((c) => (c.params!['source'] as string).includes('__bpAudioOutput'));
    expect(scriptCall).toBeDefined();
    expect(scriptCall!.params!['source']).toContain('ScriptProcessor');
    expect(scriptCall!.params!['source']).toContain('AudioNode');

    // Immediate evaluation
    const evalCalls = cdp.findAllCalls('Runtime.evaluate');
    const captureEval = evalCalls.find((c) =>
      (c.params!['expression'] as string).includes('__bpAudioOutput')
    );
    expect(captureEval).toBeDefined();
  });

  test('setup is idempotent', async () => {
    const cdp = createMockCDPClient();
    const output = new AudioOutput(cdp as unknown as CDPClient);
    await output.setup();
    const count = cdp.sent.length;

    await output.setup();
    expect(cdp.sent.length).toBe(count);
  });

  test('start auto-sets up if not already set up', async () => {
    const cdp = createMockCDPClient();
    const output = new AudioOutput(cdp as unknown as CDPClient);
    expect(output.isSetup).toBe(false);

    await output.start();

    expect(output.isSetup).toBe(true);
  });

  test('start calls __bpAudioOutput.start()', async () => {
    const cdp = createMockCDPClient();
    const output = new AudioOutput(cdp as unknown as CDPClient);
    await output.setup();
    await output.start();

    const evalCalls = cdp.findAllCalls('Runtime.evaluate');
    const startCall = evalCalls.find(
      (c) =>
        (c.params!['expression'] as string).includes('__bpAudioOutput') &&
        (c.params!['expression'] as string).includes('start()')
    );
    expect(startCall).toBeDefined();
  });

  test('stop returns empty result when no audio captured', async () => {
    const cdp = createMockCDPClient();
    const output = new AudioOutput(cdp as unknown as CDPClient);
    await output.setup();
    await output.start();

    const result = await output.stop();
    expect(result.chunkCount).toBe(0);
    expect(result.durationMs).toBe(0);
    expect(result.left.length).toBe(0);
    expect(result.right.length).toBe(0);
    expect(result.sampleRate).toBe(48000);
  });

  test('handles incoming audio data via binding', async () => {
    const cdp = createMockCDPClient();
    const output = new AudioOutput(cdp as unknown as CDPClient);
    await output.setup();
    await output.start();

    const payload = createFakeAudioPayload(4800, 0.5);
    cdp.emit('Runtime.bindingCalled', {
      name: '__bpAudioOutputData',
      payload,
    });

    const result = await output.stop();
    expect(result.chunkCount).toBe(1);
    expect(result.left.length).toBe(4800);
    expect(result.right.length).toBe(4800);
    expect(result.sampleRate).toBe(48000);
    expect(result.durationMs).toBe(100);
  });

  test('merges multiple chunks correctly', async () => {
    const cdp = createMockCDPClient();
    const output = new AudioOutput(cdp as unknown as CDPClient);
    await output.setup();
    await output.start();

    for (let i = 0; i < 3; i++) {
      cdp.emit('Runtime.bindingCalled', {
        name: '__bpAudioOutputData',
        payload: createFakeAudioPayload(4800, 0.5),
      });
    }

    const result = await output.stop();
    expect(result.chunkCount).toBe(3);
    expect(result.left.length).toBe(4800 * 3);
    expect(result.right.length).toBe(4800 * 3);
    expect(result.durationMs).toBe(300);
  });

  test('filters binding calls by name', async () => {
    const cdp = createMockCDPClient();
    const output = new AudioOutput(cdp as unknown as CDPClient);
    await output.setup();
    await output.start();

    // Send real data + unrelated binding
    cdp.emit('Runtime.bindingCalled', {
      name: '__bpAudioOutputData',
      payload: createFakeAudioPayload(4800, 0.5),
    });
    cdp.emit('Runtime.bindingCalled', {
      name: 'someOtherBinding',
      payload: 'irrelevant',
    });

    const result = await output.stop();
    expect(result.chunkCount).toBe(1);
  });

  test('tracks firstChunkTime for non-silent audio', async () => {
    const cdp = createMockCDPClient();
    const output = new AudioOutput(cdp as unknown as CDPClient);
    await output.setup();
    await output.start();

    expect(output.firstChunkTime).toBeNull();

    cdp.emit('Runtime.bindingCalled', {
      name: '__bpAudioOutputData',
      payload: createFakeAudioPayload(4800, 0.5),
    });

    expect(output.firstChunkTime).not.toBeNull();
    expect(output.firstChunkTime).toBeGreaterThan(0);
  });

  test('onData callback fires for each chunk', async () => {
    const cdp = createMockCDPClient();
    const output = new AudioOutput(cdp as unknown as CDPClient);
    await output.setup();

    const receivedChunks: number[] = [];
    output.onData((chunk) => {
      receivedChunks.push(chunk.samples);
    });

    await output.start();

    cdp.emit('Runtime.bindingCalled', {
      name: '__bpAudioOutputData',
      payload: createFakeAudioPayload(1000, 0.3),
    });

    cdp.emit('Runtime.bindingCalled', {
      name: '__bpAudioOutputData',
      payload: createFakeAudioPayload(2000, 0.4),
    });

    expect(receivedChunks).toEqual([1000, 2000]);
    await output.stop();
  });

  test('teardown cleans up', async () => {
    const cdp = createMockCDPClient();
    const output = new AudioOutput(cdp as unknown as CDPClient);
    await output.setup();
    expect(output.isSetup).toBe(true);

    await output.teardown();
    expect(output.isSetup).toBe(false);
  });

  test('ignores malformed payloads gracefully', async () => {
    const cdp = createMockCDPClient();
    const output = new AudioOutput(cdp as unknown as CDPClient);
    await output.setup();
    await output.start();

    cdp.emit('Runtime.bindingCalled', {
      name: '__bpAudioOutputData',
      payload: 'not valid json {{{',
    });

    const result = await output.stop();
    expect(result.chunkCount).toBe(0);
  });
});
