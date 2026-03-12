/**
 * Env command - Browser/environment controls for sessions
 */

import { dirname } from 'node:path';
import { connect, getBrowserWebSocketUrl, type Page } from '../../index.ts';
import { grantAudioPermissions } from '../../audio/permissions.ts';
import {
  applyNetworkOverride,
  applyPermissionState,
  applyVisibilityState,
  normalizeStoredPermission,
  originFromUrl,
  type StoredPermissionName,
} from '../env-state.ts';
import {
  generateSessionId,
  getDefaultSession,
  getSessionFilePath,
  loadSession,
  saveSession,
  updateSession,
} from '../session.ts';
import type { EnvSettings, SessionData } from '../session.ts';

const ENV_HELP = `
bp env - Browser/session environment controls

When to use:
  You need deterministic permission, network, visibility, or geolocation changes without dropping to raw CDP or eval.

When not to use:
  You are inspecting or automating DOM interactions. Use \`bp snapshot\`, \`bp exec\`, \`bp record\`, or \`bp trace\`.

Default flow:
  change environment -> run exec or audio flow -> inspect with trace summary or watch

Common mistake:
  Treating \`env\` as a generic utilities bucket. It is only for browser and session state controls.

Use this namespace when you need deterministic controls over browser permissions,
network, visibility, or geolocation during investigation and automation.

Usage:
  bp env permissions <action> [permission] [options]
  bp env network <action> [options]
  bp env visibility <state> [options]
  bp env geolocation <action> [options]

Subcommands:
  permissions  grant, revoke, reset, get
  network      offline, online, throttle
  visibility   hidden, visible
  geolocation  set, clear

Common options:
  -s, --session <id>     Session to use (omit: auto-connect, -s: latest, -s <id>: specific)
  -h, --help             Show help

Examples:
  # Browser permissions
  bp env permissions get -s my-session microphone
  bp env permissions grant -s my-session microphone
  bp env permissions reset -s my-session

  # Network control
  bp env network offline -s my-session
  bp env network online -s my-session
  bp env network throttle -s my-session --latency 200 --down 128kbps --up 64kbps

  # Visibility
  bp env visibility hidden -s my-session
  bp env visibility visible -s my-session

  # Geolocation
  bp env geolocation set -s my-session --lat 37.7749 --lon -122.4194
  bp env geolocation clear -s my-session

Likely next commands:
  bp trace watch -s my-session --view ws --assert profile:reconnect
  bp exec -s my-session '[{"action":"assertPermission","name":"microphone","state":"granted"}]'
  bp trace summary -s my-session --view permissions
`;

type PermissionMode = 'get' | 'grant' | 'revoke' | 'reset';
type PermissionArg =
  | 'microphone'
  | 'camera'
  | 'notifications'
  | 'geolocation'
  | 'audio'
  | 'audioCapture'
  | 'all';
type NetworkAction = 'offline' | 'online' | 'throttle';
type VisibilityStateArg = 'hidden' | 'visible';
type GeoAction = 'set' | 'clear';

type PermissionQuery = { name: string; state: string };

namespace PermissionNames {
  export const NAVIGATION: Record<PermissionArg, string> = {
    microphone: 'microphone',
    camera: 'camera',
    notifications: 'notifications',
    geolocation: 'geolocation',
    audio: 'audio',
    audioCapture: 'audio-capture',
    all: 'all',
  };

  export const PROTOCOL: Record<PermissionArg, string> = {
    microphone: 'audioCapture',
    camera: 'videoCapture',
    notifications: 'notifications',
    geolocation: 'geolocation',
    audio: 'audioCapture',
    audioCapture: 'audioCapture',
    all: 'all',
  };
}

interface EnvOptions {
  topCommand?: 'permissions' | 'network' | 'visibility' | 'geolocation';
  permissionMode?: PermissionMode;
  permissionName?: PermissionArg | string;
  networkAction?: NetworkAction;
  visibility?: VisibilityStateArg;
  geoAction?: GeoAction;
  help?: boolean;

  useLatestSession?: boolean;

  // Network/throttle options
  duration?: number;
  latency?: number;
  down?: string;
  up?: string;

  // Geolocation options
  lat?: number;
  lon?: number;
  accuracy?: number;
}

interface ResolvedConnection {
  browser: ReturnType<typeof connect> extends Promise<infer T> ? T : never;
  session: SessionData;
}

type PermissionPage = Pick<Page, 'evaluate' | 'cdpClient'>;
type CDPPage = Pick<Page, 'cdpClient'>;
type GeolocationPage = Pick<Page, 'setGeolocation' | 'clearGeolocation'>;

export function parseEnvArgs(args: string[]): EnvOptions {
  const options: EnvOptions = {};
  let i = 0;

  for (; i < args.length; i++) {
    const arg = args[i]!;

    if (!options.topCommand && (arg === 'permissions' || arg === 'network' || arg === 'visibility' || arg === 'geolocation')) {
      options.topCommand = arg;
      continue;
    }

    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }

    if (arg === '-s' || arg === '--session') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        // consumed in main command layer
      }
      const after = args[i + 1];
      if (!after || after.startsWith('-')) {
        options.useLatestSession = true;
      }
      continue;
    }

    if (arg === '--lat') {
      options.lat = Number.parseFloat(args[++i] ?? '0');
      continue;
    }

    if (arg === '--lon') {
      options.lon = Number.parseFloat(args[++i] ?? '0');
      continue;
    }

    if (arg === '--accuracy' || arg === '--acc') {
      options.accuracy = Number.parseFloat(args[++i] ?? '1');
      continue;
    }

    if (arg === '--duration') {
      const value = Number.parseInt(args[++i] ?? '0', 10);
      if (Number.isFinite(value) && value > 0) options.duration = value;
      continue;
    }

    if (arg === '--latency') {
      const value = Number.parseInt(args[++i] ?? '0', 10);
      if (Number.isFinite(value) && value >= 0) options.latency = value;
      continue;
    }

    if (arg === '--down') {
      options.down = args[++i];
      continue;
    }

    if (arg === '--up') {
      options.up = args[++i];
      continue;
    }

    if (!arg.startsWith('-') && options.topCommand) {
      if (options.topCommand === 'permissions') {
        if (!options.permissionMode) {
          options.permissionMode = arg as PermissionMode;
          continue;
        }
        if (!options.permissionName && options.permissionMode !== 'get' && options.permissionMode !== 'reset') {
          options.permissionName = arg as PermissionArg;
          continue;
        }
        if (!options.permissionName && options.permissionMode === 'get') {
          options.permissionName = arg as PermissionArg;
          continue;
        }
      }

      if (options.topCommand === 'network') {
        options.networkAction = arg as NetworkAction;
        continue;
      }

      if (options.topCommand === 'visibility') {
        options.visibility = arg as VisibilityStateArg;
        continue;
      }

      if (options.topCommand === 'geolocation') {
        options.geoAction = arg as GeoAction;
        continue;
      }
    }
  }

  return options;
}

function coercePermissionArg(value: string): PermissionArg | string {
  return value as PermissionArg;
}

function toBytesPerSecond(raw?: string): number | undefined {
  if (!raw) return undefined;

  const text = raw.trim().toLowerCase();
  const match = text.match(/^([0-9]*\.?[0-9]+)\s*(kbps|mbps|k|m)?$/);
  if (!match || !match[1]) return undefined;

  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;

  const unit = match[2] ?? 'kbps';
  if (unit === 'mbps' || unit === 'm') return Math.round((value * 1_000_000) / 8);
  return Math.round((value * 1000) / 8);
}

async function resolveConnection(sessionId?: string, useLatestSession = false): Promise<ResolvedConnection> {
  if (sessionId) {
    const session = await loadSession(sessionId);
    const browser = await connect({ provider: session.provider, wsUrl: session.wsUrl });
    return { browser, session };
  }

  if (useLatestSession) {
    const defaultSession = await getDefaultSession();
    if (!defaultSession) {
      throw new Error('No sessions found. Run "bp connect" first or use "-s" for latest session.');
    }
    const browser = await connect({ provider: defaultSession.provider, wsUrl: defaultSession.wsUrl });
    return { browser, session: defaultSession };
  }

  let wsUrl: string;
  try {
    wsUrl = await getBrowserWebSocketUrl('localhost:9222');
  } catch {
    throw new Error(
      'Could not auto-discover browser.\n' +
        'Either:\n' +
        '  1) Start Chrome with: --remote-debugging-port=9222\n' +
        '  2) Use an existing session: bp env -s <id> ...\n' +
        '  3) Use latest session: bp env -s'
    );
  }

  const browser = await connect({ provider: 'generic', wsUrl });
  const page = await browser.page();
  const currentUrl = await page.url();
  const newSessionId = generateSessionId();

  const session: SessionData = {
    id: newSessionId,
    provider: 'generic',
    wsUrl: browser.wsUrl,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    currentUrl,
  };

  await saveSession(session);
  const sessionFile = getSessionFilePath(newSessionId);
  await import('node:fs/promises').then((fs) => fs.mkdir(dirname(sessionFile), { recursive: true }));
  return { browser, session };
}

function clampRate(value?: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function isStoredPermissionName(value: StoredPermissionName | null): value is StoredPermissionName {
  return value !== null;
}

async function getPermissionStates(page: Pick<Page, 'evaluate'>): Promise<PermissionQuery[]> {
  const expr = `
    (() => {
      const names = ['geolocation', 'microphone', 'audio-capture', 'camera', 'notifications', 'clipboard-read', 'clipboard-write'];
      return Promise.all(names.map(async (name) => {
        if (!navigator.permissions || !navigator.permissions.query) {
          return { name, state: 'unsupported' };
        }
        try {
          const result = await navigator.permissions.query({ name });
          return { name, state: result.state };
        } catch {
          return { name, state: 'unsupported' };
        }
      }));
    })()
  `;

  return (await page.evaluate<PermissionQuery[]>(expr)) as PermissionQuery[];
}

async function permissionCommand(
  action: PermissionMode,
  nameInput: PermissionArg | string | undefined,
  page: PermissionPage
): Promise<{ action: PermissionMode; name: string; state?: unknown }[]> {
  const requested =
    nameInput && nameInput !== 'all' ? coercePermissionArg(nameInput) : 'all';

  if (action === 'get') {
    const states = await getPermissionStates(page);
    if (requested !== 'all') {
      const lower = String(requested).toLowerCase();
      return states
        .filter((item) => item.name === lower || item.name === PermissionNames.NAVIGATION[requested as PermissionArg])
        .map((item) => ({ action, name: item.name, state: item.state }));
    }
    return states.map((item) => ({ action, name: item.name, state: item.state }));
  }

  const permissionNames = requested === 'all' ? Object.values(PermissionNames.NAVIGATION).filter((v) => v !== 'all') : [PermissionNames.NAVIGATION[requested as PermissionArg] ?? String(requested)];

  const protocolNames = requested === 'all'
    ? ['geolocation', 'audioCapture', 'videoCapture', 'notifications']
    : permissionNames.map((item) => PermissionNames.PROTOCOL[item as PermissionArg] ?? String(item));

  if (action === 'grant') {
    const origin = await page.evaluate<string>("window.location.origin");
    await page.cdpClient.send('Browser.grantPermissions', {
      permissions: protocolNames.filter((value) => value !== 'all' && value !== 'audio'),
      origin,
    });

    if (permissionNames.includes('microphone')) {
      await grantAudioPermissions(page.cdpClient, origin);
    }

    const result = await getPermissionStates(page);
    return result.map((item) => ({ action, name: item.name, state: item.state }));
  }

  const origin = await page.evaluate<string>("window.location.origin");
  if (action === 'revoke' || action === 'reset') {
    for (const permission of protocolNames) {
      if (permission === 'all') continue;
      try {
        await page.cdpClient.send('Browser.resetPermissions', {
          permissions: [permission],
          origin,
        });
      } catch {
        await page.cdpClient.send('Browser.revokePermissions', {
          permissions: [permission],
          origin,
        } as Record<string, unknown>);
      }
    }

    const result = await getPermissionStates(page);
    return result.map((item) => ({ action, name: item.name, state: item.state }));
  }

  throw new Error(`Unsupported permission action: ${action}`);
}

function formatPermissionOutput(session: SessionData, data: { action: PermissionMode; name: string; state?: unknown }[]): string {
  const lines = [`Session: ${session.id}`, ''];
  for (const row of data) {
    lines.push(`${row.name}: ${row.state ?? 'unknown'} (${row.action})`);
  }
  return lines.join('\n');
}

async function runNetworkCommand(
  action: NetworkAction,
  options: EnvOptions,
  page: CDPPage,
  session: SessionData
): Promise<void> {
  await page.cdpClient.send('Network.enable');

  const applyNetworkState = async (
    offline: boolean,
    latency: number,
    downloadThroughput: number,
    uploadThroughput: number,
    connectionType: string
  ) => {
    const state = {
      offline,
      latency,
      downloadThroughput,
      uploadThroughput,
      connectionType,
    } as Record<string, unknown>;

    try {
      await page.cdpClient.send('Network.emulateNetworkConditionsByRule', {
        offline,
        matchedNetworkConditions: [
          {
            urlPattern: '',
            latency,
            downloadThroughput,
            uploadThroughput,
          },
        ],
      } as Record<string, unknown>);
      await page.cdpClient.send('Network.overrideNetworkState', state);
    } catch {
      await page.cdpClient.send('Network.emulateNetworkConditions', state);
    }
  };

  if (action === 'offline') {
    await applyNetworkState(true, options.latency ?? 0, 0, 0, 'none');
    await applyNetworkOverride(page.cdpClient, {
      offline: true,
      latency: options.latency ?? 0,
    });

    console.log(`Session ${session.id}: network set to offline`);
    return;
  }

  if (action === 'online') {
    await applyNetworkState(false, 0, -1, -1, 'wifi');
    await applyNetworkOverride(page.cdpClient, {
      offline: false,
      latency: 0,
    });

    console.log(`Session ${session.id}: network set to online`);
    return;
  }

  const latency = clampRate(options.latency) ?? 0;
  const down = clampRate(toBytesPerSecond(options.down)) ?? 1_000_000;
  const up = clampRate(toBytesPerSecond(options.up)) ?? 500_000;

  await applyNetworkState(false, latency, down, up, 'wifi');
  await applyNetworkOverride(page.cdpClient, {
    offline: false,
    latency,
  });

  console.log(`Session ${session.id}: network throttled | latency=${latency}ms down=${down}B/s up=${up}B/s`);
}

async function runVisibilityCommand(
  state: VisibilityStateArg,
  page: CDPPage,
  session: SessionData
): Promise<void> {
  await applyVisibilityState(page.cdpClient, state);
  console.log(`Session ${session.id}: visibility set to ${state}`);
}

async function runGeolocationCommand(
  action: GeoAction,
  options: EnvOptions,
  page: GeolocationPage,
  session: SessionData
): Promise<void> {
  if (action === 'clear') {
    await page.clearGeolocation();
    console.log(`Session ${session.id}: geolocation override cleared`);
    return;
  }

  if (options.lat === undefined || options.lon === undefined) {
    throw new Error('geolocation set requires --lat and --lon');
  }

  await page.setGeolocation({
    latitude: options.lat,
    longitude: options.lon,
    accuracy: options.accuracy ?? 1,
  });
  console.log(`Session ${session.id}: geolocation set to ${options.lat}, ${options.lon} (accuracy ${options.accuracy ?? 1})`);
}

export async function envCommand(
  args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; help?: boolean; trace?: boolean }
): Promise<void> {
  const options = parseEnvArgs(args);

  if (options.help || globalOptions.help || !options.topCommand) {
    console.log(ENV_HELP);
    return;
  }

  const { browser, session } = await resolveConnection(globalOptions.session, options.useLatestSession ?? false);
  const page = await browser.page(undefined, { targetId: session.targetId });
  const outputAsJson = globalOptions.format === 'json';
  const existingEnv = (session.metadata?.env ?? {}) as EnvSettings;

  try {
    if (options.topCommand === 'permissions') {
      const permissionMode = options.permissionMode ?? 'get';
      if (permissionMode === 'get' && !options.permissionName) {
        const result = await permissionCommand(permissionMode, 'all', page);
        if (outputAsJson) {
          console.log(JSON.stringify({ session: session.id, permissions: result }, null, 2));
        } else {
          console.log(formatPermissionOutput(session, result));
        }
        return;
      }

      const result = await permissionCommand(permissionMode, options.permissionName, page);
      if (permissionMode !== 'get') {
        const nextPermissions =
          permissionMode === 'reset'
            ? []
            : (() => {
                const current = new Set<StoredPermissionName>(
                  (existingEnv.permissions ?? [])
                    .map((value) => normalizeStoredPermission(value))
                    .filter(isStoredPermissionName)
                );
                const requested: StoredPermissionName[] =
                  options.permissionName === 'all' || !options.permissionName
                    ? ['microphone', 'camera', 'notifications', 'geolocation']
                    : [normalizeStoredPermission(options.permissionName)].filter(isStoredPermissionName);
                if (permissionMode === 'grant') {
                  for (const name of requested) current.add(name);
                } else {
                  for (const name of requested) current.delete(name);
                }
                return [...current];
              })();

        const nextEnv: EnvSettings = {
          ...existingEnv,
          permissions: nextPermissions,
        };
        await updateSession(session.id, { metadata: { env: nextEnv } });
        const currentUrl = await page.evaluate<string>('window.location.href');
        await applyPermissionState(page.cdpClient, originFromUrl(currentUrl), nextPermissions);
      }
      if (outputAsJson) {
        console.log(JSON.stringify({ session: session.id, action: permissionMode, permissions: result }, null, 2));
      } else {
        console.log(formatPermissionOutput(session, result));
      }
      return;
    }

    if (options.topCommand === 'network') {
      const action = options.networkAction;
      if (!action) {
        throw new Error('network command requires action: offline, online, or throttle');
      }
      await runNetworkCommand(action, options, page, session);
      await updateSession(session.id, {
        metadata: {
          env: {
            ...existingEnv,
            network:
              action === 'online'
                ? {
                    offline: false,
                    latency: 0,
                  }
                : {
                    offline: action === 'offline',
                    latency: action === 'throttle' ? options.latency ?? 0 : options.latency ?? 0,
                  },
          },
        },
      });
      if (options.duration && options.duration > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.duration));
        if (action === 'offline' || action === 'throttle') {
          await runNetworkCommand('online', {}, page, session);
          await updateSession(session.id, {
            metadata: {
              env: {
                ...existingEnv,
                network: {
                  offline: false,
                  latency: 0,
                },
              },
            },
          });
        }
      }
      return;
    }

    if (options.topCommand === 'visibility') {
      if (!options.visibility) {
        throw new Error('visibility command requires: hidden or visible');
      }
      await runVisibilityCommand(options.visibility, page, session);
      await updateSession(session.id, {
        metadata: {
          env: {
            ...existingEnv,
            visibility: options.visibility,
          },
        },
      });
      return;
    }

    if (options.topCommand === 'geolocation') {
      if (!options.geoAction) {
        throw new Error('geolocation command requires: set or clear');
      }
      await runGeolocationCommand(options.geoAction, options, page, session);
      await updateSession(session.id, {
        metadata: {
          env: {
            ...existingEnv,
            geolocation:
              options.geoAction === 'clear'
                ? undefined
                : {
                    latitude: options.lat!,
                    longitude: options.lon!,
                    accuracy: options.accuracy ?? 1,
                  },
          },
        },
      });
      return;
    }

    throw new Error('Unknown env command. Run bp env --help for usage.');
  } finally {
    await browser.disconnect();
  }
}
