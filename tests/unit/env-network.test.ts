import { describe, expect, it, mock } from 'bun:test';
import {
  networkSettingsFor,
  parseEnvArgs,
  runNetworkCommand,
  toBytesPerSecond,
} from '../../src/cli/commands/env.ts';
import { applyNetworkEmulation } from '../../src/cli/env-state.ts';
import type { SessionData } from '../../src/cli/session.ts';

type EnvOptions = Partial<ReturnType<typeof parseEnvArgs>>;

function createMockPage(calls: { method: string; params?: unknown }[]) {
  return {
    cdpClient: {
      send: mock(async (method: string, params?: unknown) => {
        calls.push({ method, params });
        return {};
      }),
    },
  };
}

const session = { id: 'test-session' } as SessionData;

describe('runNetworkCommand', () => {
  it('calls Network.enable before Network.emulateNetworkConditions', async () => {
    const calls: { method: string; params?: unknown }[] = [];
    const page = createMockPage(calls);

    await runNetworkCommand('throttle', {}, page as never, session);

    const enableIndex = calls.findIndex((c) => c.method === 'Network.enable');
    const emulateIndex = calls.findIndex((c) => c.method === 'Network.emulateNetworkConditions');
    expect(enableIndex).toBeGreaterThanOrEqual(0);
    expect(emulateIndex).toBeGreaterThan(enableIndex);
  });

  it('never calls the experimental network emulation methods', async () => {
    const calls: { method: string; params?: unknown }[] = [];
    const page = createMockPage(calls);

    await runNetworkCommand('throttle', {}, page as never, session);
    await runNetworkCommand('online', {}, page as never, session);
    await runNetworkCommand('offline', {}, page as never, session);

    const methods = calls.map((c) => c.method);
    expect(methods).not.toContain('Network.emulateNetworkConditionsByRule');
    expect(methods).not.toContain('Network.overrideNetworkState');
  });

  it('converts --down 80kbps to downloadThroughput: 10000 bytes/sec', () => {
    expect(toBytesPerSecond('80kbps')).toBe(10000);
  });

  it('applies the converted throughput values on throttle', async () => {
    const calls: { method: string; params?: unknown }[] = [];
    const page = createMockPage(calls);

    const options: EnvOptions = { latency: 200, down: '80kbps', up: '40kbps' };
    await runNetworkCommand('throttle', options as never, page as never, session);

    const emulateCall = calls.find((c) => c.method === 'Network.emulateNetworkConditions');
    expect(emulateCall?.params).toMatchObject({
      offline: false,
      latency: 200,
      downloadThroughput: 10000,
      uploadThroughput: 5000,
    });
  });

  it('sends offline:false, latency:0, and unbounded throughput on online', async () => {
    const calls: { method: string; params?: unknown }[] = [];
    const page = createMockPage(calls);

    await runNetworkCommand('online', {} as never, page as never, session);

    const emulateCall = calls.find((c) => c.method === 'Network.emulateNetworkConditions');
    expect(emulateCall?.params).toMatchObject({
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  });

  it('sends offline:true on offline', async () => {
    const calls: { method: string; params?: unknown }[] = [];
    const page = createMockPage(calls);

    await runNetworkCommand('offline', {} as never, page as never, session);

    const emulateCall = calls.find((c) => c.method === 'Network.emulateNetworkConditions');
    expect(emulateCall?.params).toMatchObject({
      offline: true,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
  });
});

function createMockCdp(calls: { method: string; params?: unknown }[]) {
  return {
    send: mock(async (method: string, params?: unknown) => {
      calls.push({ method, params });
      return {};
    }),
  } as never;
}

describe('applyNetworkEmulation (re-apply on attach)', () => {
  it('is a no-op when settings are undefined', async () => {
    const calls: { method: string; params?: unknown }[] = [];
    const cdp = createMockCdp(calls);

    await applyNetworkEmulation(cdp, undefined);

    expect(calls).toHaveLength(0);
  });

  it('sends -1/-1 throughput for a legacy shape without throughput while online', async () => {
    const calls: { method: string; params?: unknown }[] = [];
    const cdp = createMockCdp(calls);

    await applyNetworkEmulation(cdp, { offline: false, latency: 200 });

    const emulateCall = calls.find((c) => c.method === 'Network.emulateNetworkConditions');
    expect(emulateCall?.params).toMatchObject({
      offline: false,
      latency: 200,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  });

  it('sends 0/0 throughput for a legacy offline shape without throughput', async () => {
    const calls: { method: string; params?: unknown }[] = [];
    const cdp = createMockCdp(calls);

    await applyNetworkEmulation(cdp, { offline: true, latency: 50 });

    const emulateCall = calls.find((c) => c.method === 'Network.emulateNetworkConditions');
    expect(emulateCall?.params).toMatchObject({
      offline: true,
      latency: 50,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
  });

  it('passes explicit throughput through unchanged for the full shape', async () => {
    const calls: { method: string; params?: unknown }[] = [];
    const cdp = createMockCdp(calls);

    await applyNetworkEmulation(cdp, {
      offline: false,
      latency: 200,
      downloadThroughput: 10000,
      uploadThroughput: 5000,
    });

    const emulateCall = calls.find((c) => c.method === 'Network.emulateNetworkConditions');
    expect(emulateCall?.params).toMatchObject({
      offline: false,
      latency: 200,
      downloadThroughput: 10000,
      uploadThroughput: 5000,
    });
  });

  it('calls Network.enable before Network.emulateNetworkConditions', async () => {
    const calls: { method: string; params?: unknown }[] = [];
    const cdp = createMockCdp(calls);

    await applyNetworkEmulation(cdp, { offline: false, latency: 0 });

    const enableIndex = calls.findIndex((c) => c.method === 'Network.enable');
    const emulateIndex = calls.findIndex((c) => c.method === 'Network.emulateNetworkConditions');
    expect(enableIndex).toBeGreaterThanOrEqual(0);
    expect(emulateIndex).toBeGreaterThan(enableIndex);
  });
});

describe('parseEnvArgs (network options)', () => {
  it('parses --duration, --latency, --down, --up together', () => {
    const options = parseEnvArgs([
      'network',
      'throttle',
      '--latency',
      '200',
      '--down',
      '128kbps',
      '--up',
      '64kbps',
      '--duration',
      '5000',
    ]);
    expect(options.topCommand).toBe('network');
    expect(options.networkAction).toBe('throttle');
    expect(options.latency).toBe(200);
    expect(options.down).toBe('128kbps');
    expect(options.up).toBe('64kbps');
    expect(options.duration).toBe(5000);
  });

  it('parses --recreate-tab on network online', () => {
    const options = parseEnvArgs(['network', 'online', '--recreate-tab']);
    expect(options.topCommand).toBe('network');
    expect(options.networkAction).toBe('online');
    expect(options.recreateTab).toBe(true);
  });

  it('parses --recreate-tab regardless of the action it is paired with (validated at runtime)', () => {
    const options = parseEnvArgs(['network', 'throttle', '--recreate-tab']);
    expect(options.networkAction).toBe('throttle');
    expect(options.recreateTab).toBe(true);
  });
});

describe('networkSettingsFor (persisted EnvSettings.network)', () => {
  it('persists full throughput shape on throttle', () => {
    const options: EnvOptions = { latency: 200, down: '128kbps', up: '64kbps' };
    expect(networkSettingsFor('throttle', options as never)).toEqual({
      offline: false,
      latency: 200,
      downloadThroughput: 16000,
      uploadThroughput: 8000,
    });
  });

  it('clears persisted network settings on online', () => {
    expect(networkSettingsFor('online', {} as never)).toBeUndefined();
  });

  it('persists offline shape with zeroed throughput', () => {
    expect(networkSettingsFor('offline', { latency: 50 } as never)).toEqual({
      offline: true,
      latency: 50,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
  });
});
