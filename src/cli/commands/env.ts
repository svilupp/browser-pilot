/**
 * Env command - Browser/environment controls for sessions
 */

import { homedir } from 'node:os';
import { dirname } from 'node:path';
import {
  loadCookieStateFile,
  resolveCookieStateRef,
  saveCookieStateFile,
} from '../../adapters/node/cookie-state-files.ts';
import { grantAudioPermissions } from '../../audio/permissions.ts';
import { captureCookieState } from '../../auth/cookie-state.ts';
import { CookieStateError } from '../../auth/errors.ts';
import type { Browser } from '../../browser/browser.ts';
import { countSessionReferences } from '../../daemon/registry.ts';
import type { Page } from '../../index.ts';
import { getEnv } from '../../runtime/env.ts';
import { type AttachResult, applySessionEnvironment, attachSession } from '../attach.ts';
import { formatBrowserDiscoveryError, resolveCLIEndpoint } from '../browser-endpoint.ts';
import { createLocalSession } from '../connect-service.ts';
import {
  applyNetworkOverride,
  applyPermissionState,
  applyVisibilityState,
  normalizeStoredPermission,
  originFromUrl,
  type StoredPermissionName,
} from '../env-state.ts';
import type { EnvSettings, SessionData } from '../session.ts';
import {
  getDefaultSession,
  getSessionFilePath,
  loadSession,
  updateSession,
  updateSessionTargetBinding,
} from '../session.ts';

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
  bp env auth <action> [options]

Subcommands:
  permissions  grant, revoke, reset, get
  network      offline, online, throttle
  visibility   hidden, visible
  geolocation  set, clear
  auth         set-headers, set-cookie, clear (Cloudflare-Access-style auth persistence),
               save, inspect (URL-scoped cookie snapshot files);
               see docs/guides/auth-cookies.md for the full lifecycle semantics

Network options:
  --latency <ms>         Added round-trip latency (throttle, offline)
  --down <rate>          Download cap, e.g. 128kbps, 1mbps, or raw bytes/sec (throttle)
  --up <rate>            Upload cap, same rate syntax (throttle)
  --duration <ms>        Auto-restore to online after N ms (throttle, offline)
  --recreate-tab         network online only: swap in a fresh tab/target at the
                         same URL instead of clearing conditions on the existing
                         one; loses page state (scroll, in-memory JS, unsubmitted forms)

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
  bp env network throttle -s my-session --latency 200 --down 128kbps --duration 5000
  bp env network online -s my-session --recreate-tab

  # Visibility
  bp env visibility hidden -s my-session
  bp env visibility visible -s my-session

  # Geolocation
  bp env geolocation set -s my-session --lat 37.7749 --lon -122.4194
  bp env geolocation clear -s my-session

  # Auth (Cloudflare Access, persisted + reapplied on every attach)
  bp env auth set-headers -s my-session --from-env CF-Access-Client-Id=CF_ACCESS_CLIENT_ID --from-env CF-Access-Client-Secret=CF_ACCESS_CLIENT_SECRET
  bp env auth set-cookie CF_Authorization -s my-session --value-from-env CF_ACCESS_JWT --domain example.com
  bp env auth clear -s my-session

  # Auth (URL-scoped cookie snapshots)
  bp env auth save shopify -s shopify-login
  bp env auth save shopify -s shopify-login --include-url https://accounts.shopify.com --force
  bp env auth inspect shopify

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
type AuthAction = 'set-headers' | 'set-cookie' | 'clear' | 'save' | 'inspect';

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
  topCommand?: 'permissions' | 'network' | 'visibility' | 'geolocation' | 'auth';
  permissionMode?: PermissionMode;
  permissionName?: string;
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
  recreateTab?: boolean;

  // Geolocation options
  lat?: number;
  lon?: number;
  accuracy?: number;

  // Auth options
  authAction?: AuthAction;
  authFromEnv?: Record<string, string>;
  authCookieName?: string;
  authValueFromEnv?: string;
  authDomain?: string;
  authPath?: string;
  authSecure?: boolean;
  authRef?: string;
  authIncludeUrls?: string[];
  authForce?: boolean;
}

interface ResolvedConnection {
  browser: Browser;
  session: SessionData;
  /**
   * Page pinned by `attachSession` to the persistent daemon flat session
   * (`session.daemon.cdpSessionId`). Reusing it (instead of re-attaching a
   * fresh flat session via `browser.page()`) keeps env mutations like
   * `network throttle`/`network online` on the same CDP session.
   */
  page?: AttachResult['page'];
}

type PermissionPage = Pick<Page, 'evaluate' | 'cdpClient'>;
type CDPPage = Pick<Page, 'cdpClient'>;
type GeolocationPage = Pick<Page, 'setGeolocation' | 'clearGeolocation'>;

export function parseEnvArgs(args: string[]): EnvOptions {
  const options: EnvOptions = {};
  let i = 0;

  for (; i < args.length; i++) {
    const arg = args[i]!;

    if (
      !options.topCommand &&
      (arg === 'permissions' ||
        arg === 'network' ||
        arg === 'visibility' ||
        arg === 'geolocation' ||
        arg === 'auth')
    ) {
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

    if (arg === '--recreate-tab') {
      options.recreateTab = true;
      continue;
    }

    if (arg === '--from-env') {
      const raw = args[++i] ?? '';
      const eq = raw.indexOf('=');
      if (eq === -1) {
        throw new Error(`--from-env expects HeaderName=ENV_VAR_NAME, got: ${raw}`);
      }
      const headerName = raw.slice(0, eq);
      const envVarName = raw.slice(eq + 1);
      options.authFromEnv = { ...options.authFromEnv, [headerName]: envVarName };
      continue;
    }

    if (arg === '--value-from-env') {
      options.authValueFromEnv = args[++i];
      continue;
    }

    if (arg === '--domain') {
      options.authDomain = args[++i];
      continue;
    }

    if (arg === '--path') {
      options.authPath = args[++i];
      continue;
    }

    if (arg === '--secure') {
      options.authSecure = true;
      continue;
    }

    if (arg === '--include-url') {
      const value = args[++i];
      if (value) {
        options.authIncludeUrls = [...(options.authIncludeUrls ?? []), value];
      }
      continue;
    }

    if (arg === '--force') {
      options.authForce = true;
      continue;
    }

    if (!arg.startsWith('-') && options.topCommand) {
      if (options.topCommand === 'permissions') {
        if (!options.permissionMode) {
          options.permissionMode = arg as PermissionMode;
          continue;
        }
        if (
          !options.permissionName &&
          options.permissionMode !== 'get' &&
          options.permissionMode !== 'reset'
        ) {
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
      }

      if (options.topCommand === 'auth') {
        if (!options.authAction) {
          options.authAction = arg as AuthAction;
          continue;
        }
        if (options.authAction === 'set-cookie' && !options.authCookieName) {
          options.authCookieName = arg;
          continue;
        }
        if (
          (options.authAction === 'save' || options.authAction === 'inspect') &&
          !options.authRef
        ) {
          options.authRef = arg;
        }
      }
    }
  }

  return options;
}

function coercePermissionArg(value: string): string {
  return value;
}

export function toBytesPerSecond(raw?: string): number | undefined {
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

async function resolveConnection(
  sessionId?: string,
  useLatestSession = false
): Promise<ResolvedConnection> {
  if (sessionId) {
    const session = await loadSession(sessionId);
    const { browser, page, session: attachedSession } = await attachSession(session);
    return { browser, session: attachedSession, page };
  }

  if (useLatestSession) {
    const defaultSession = await getDefaultSession();
    if (!defaultSession) {
      throw new Error('No sessions found. Run "bp connect" first or use "-s" for latest session.');
    }
    const { browser, page, session: attachedSession } = await attachSession(defaultSession);
    return { browser, session: attachedSession, page };
  }

  let endpoint: Awaited<ReturnType<typeof resolveCLIEndpoint>>;
  try {
    endpoint = await resolveCLIEndpoint();
  } catch (error) {
    throw new Error(
      formatBrowserDiscoveryError(error, {
        explicitHint: '  - Create a session first: bp connect --browser-url <ws-url>',
        reuseSessionHint: 'bp env -s <id> ...',
        latestSessionHint: 'bp env -s',
      })
    );
  }

  const { browser, session } = await createLocalSession({
    wsUrl: endpoint.wsUrl,
    connectionSource: endpoint.source,
    resolvedChannel: endpoint.channel,
    resolvedUserDataDir: endpoint.userDataDir,
  });
  const sessionFile = getSessionFilePath(session.id);
  await import('node:fs/promises').then((fs) =>
    fs.mkdir(dirname(sessionFile), { recursive: true })
  );
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

  return page.evaluate<PermissionQuery[]>(expr);
}

async function permissionCommand(
  action: PermissionMode,
  nameInput: string | undefined,
  page: PermissionPage
): Promise<{ action: PermissionMode; name: string; state?: unknown }[]> {
  const requested = nameInput && nameInput !== 'all' ? coercePermissionArg(nameInput) : 'all';

  if (action === 'get') {
    const states = await getPermissionStates(page);
    if (requested !== 'all') {
      const lower = String(requested).toLowerCase();
      return states
        .filter(
          (item) =>
            item.name === lower ||
            item.name === PermissionNames.NAVIGATION[requested as PermissionArg]
        )
        .map((item) => ({ action, name: item.name, state: item.state }));
    }
    return states.map((item) => ({ action, name: item.name, state: item.state }));
  }

  const permissionNames =
    requested === 'all'
      ? Object.values(PermissionNames.NAVIGATION).filter((v) => v !== 'all')
      : [PermissionNames.NAVIGATION[requested as PermissionArg] ?? String(requested)];

  const protocolNames =
    requested === 'all'
      ? ['geolocation', 'audioCapture', 'videoCapture', 'notifications']
      : permissionNames.map(
          (item) => PermissionNames.PROTOCOL[item as PermissionArg] ?? String(item)
        );

  if (action === 'grant') {
    const origin = await page.evaluate<string>('window.location.origin');
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

  const origin = await page.evaluate<string>('window.location.origin');
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

function formatPermissionOutput(
  session: SessionData,
  data: { action: PermissionMode; name: string; state?: unknown }[]
): string {
  const lines = [`Session: ${session.id}`, ''];
  for (const row of data) {
    const state =
      typeof row.state === 'string'
        ? row.state
        : row.state === undefined || row.state === null
          ? 'unknown'
          : JSON.stringify(row.state);
    lines.push(`${row.name}: ${state} (${row.action})`);
  }
  return lines.join('\n');
}

/**
 * Single source of truth for the offline/latency/throughput values used by
 * both the live CDP call (`runNetworkCommand`) and the persisted session
 * shape (`networkSettingsFor`). Keeping clamping/defaults/conversion in one
 * place avoids the two call sites drifting apart.
 */
function resolveNetworkParams(
  action: NetworkAction,
  options: EnvOptions
): { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number } {
  if (action === 'offline') {
    return {
      offline: true,
      latency: clampRate(options.latency) ?? 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    };
  }

  if (action === 'online') {
    return {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    };
  }

  return {
    offline: false,
    latency: clampRate(options.latency) ?? 0,
    downloadThroughput: clampRate(toBytesPerSecond(options.down)) ?? 1_000_000,
    uploadThroughput: clampRate(toBytesPerSecond(options.up)) ?? 500_000,
  };
}

export async function runNetworkCommand(
  action: NetworkAction,
  options: EnvOptions,
  page: CDPPage,
  session: SessionData
): Promise<void> {
  await page.cdpClient.send('Network.enable');

  const { offline, latency, downloadThroughput, uploadThroughput } = resolveNetworkParams(
    action,
    options
  );

  // Classic Network.emulateNetworkConditions is the only mechanism that can
  // be undone from a fresh session. The experimental
  // Network.emulateNetworkConditionsByRule/overrideNetworkState pair leaks
  // per-target rules that outlive session detach and cannot be cleared, so
  // `bp env network online` could never undo a prior throttle. Never use them.
  await page.cdpClient.send('Network.emulateNetworkConditions', {
    offline,
    latency,
    downloadThroughput,
    uploadThroughput,
  });
  await applyNetworkOverride(page.cdpClient, { offline, latency });

  if (action === 'offline') {
    console.log(`Session ${session.id}: network set to offline`);
    return;
  }
  if (action === 'online') {
    console.log(`Session ${session.id}: network set to online`);
    return;
  }
  console.log(
    `Session ${session.id}: network throttled | latency=${latency}ms down=${downloadThroughput}B/s up=${uploadThroughput}B/s`
  );
}

export function networkSettingsFor(
  action: NetworkAction,
  options: EnvOptions
): EnvSettings['network'] {
  if (action === 'online') {
    // Clear the persisted throttle entirely so a stored session never carries
    // stale throughput/latency once online is restored.
    return undefined;
  }

  return resolveNetworkParams(action, options);
}

/**
 * `bp env network online --recreate-tab`: swap the pinned session onto a
 * brand-new tab at the same URL. Network conditions are session-keyed (both
 * the classic and now-removed experimental CDP mechanisms), so a tab that
 * was throttled by an older bp version — or by a session that never got
 * cleaned up — keeps its rules until its *own* CDP session detaches. Rather
 * than requiring the caller to hunt down and close that tab manually, this
 * creates a fresh target, re-points the session at it, best-effort detaches
 * the stale pinned session (unless another logical session still references
 * it, mirroring `use-target.ts`), and closes the old target. Page state
 * (scroll position, in-memory JS state, unsubmitted form input) is lost.
 */
/** Validates flag combinations for `bp env network <action>` before any CDP call runs. */
export function validateNetworkOptions(action: NetworkAction, options: EnvOptions): void {
  if (options.recreateTab && action !== 'online') {
    throw new Error('--recreate-tab is only valid with "network online"');
  }
  if (options.duration && options.duration > 0 && action === 'online') {
    throw new Error(
      '--duration is not valid with "network online" (there is nothing to restore from)'
    );
  }
}

export async function recreateTab(
  page: Page,
  session: SessionData,
  browser: Browser
): Promise<{ oldTargetId: string; newTargetId: string }> {
  const oldTargetId = session.targetId;
  if (!oldTargetId) {
    throw new Error('--recreate-tab requires a session with an attached target');
  }

  let currentUrl: string;
  try {
    currentUrl = await page.url();
    if (!currentUrl) currentUrl = session.currentUrl ?? 'about:blank';
  } catch {
    currentUrl = session.currentUrl ?? 'about:blank';
  }
  const previousCdpSessionId = page.cdpClient.sessionId;

  const { targetId: newTargetId } = await page.cdpClient.send<{ targetId: string }>(
    'Target.createTarget',
    { url: currentUrl, background: true },
    null
  );

  let newPage: Page;
  let nextCdpSessionId: string | undefined;
  let updated: SessionData;
  try {
    newPage = await browser.page(undefined, { targetId: newTargetId });
    nextCdpSessionId = newPage.cdpClient.sessionId;

    updated = await updateSessionTargetBinding(session.id, {
      targetId: newTargetId,
      currentUrl,
      ...(nextCdpSessionId ? { cdpSessionId: nextCdpSessionId } : {}),
    });
  } catch (error) {
    // The new target was created but never bound to the session (re-pin
    // failed before the session file was updated) — close it so it doesn't
    // leak, then rethrow so the caller sees the original failure. The
    // session still points at the old target, which was never touched.
    await page.cdpClient
      .send('Target.closeTarget', { targetId: newTargetId }, null)
      .catch(() => {});
    throw error;
  }

  if (
    previousCdpSessionId &&
    nextCdpSessionId &&
    previousCdpSessionId !== nextCdpSessionId &&
    updated.transport?.mode === 'daemon' &&
    updated.transport.daemonId &&
    (await countSessionReferences(updated.transport.daemonId, previousCdpSessionId)) === 0
  ) {
    await newPage.cdpClient
      .send('daemon.detach', { sessionId: previousCdpSessionId }, null)
      .catch(() => {});
  }

  const closeResult = await page.cdpClient
    .send('Target.closeTarget', { targetId: oldTargetId }, null)
    .then(() => true)
    .catch(() => false);
  if (!closeResult) {
    console.warn(
      `Session ${session.id}: failed to close old target ${oldTargetId}; it may still be throttled and should be closed manually.`
    );
  }

  // Re-apply persisted env settings (permissions/geolocation/visibility/
  // network/auth) onto the new page — the fresh target starts with none of
  // them. Best-effort: the tab swap already succeeded, so a re-apply
  // failure here shouldn't be reported as a command failure.
  try {
    const freshSession = await loadSession(session.id);
    await applySessionEnvironment(newPage, currentUrl, freshSession.metadata?.env);
  } catch (error) {
    console.warn(
      `Session ${session.id}: recreated tab but failed to re-apply env settings: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  console.log(`Session ${session.id}: recreated tab ${oldTargetId} -> ${newTargetId}`);
  return { oldTargetId, newTargetId };
}

async function runVisibilityCommand(
  state: VisibilityStateArg,
  page: CDPPage,
  session: SessionData
): Promise<void> {
  await applyVisibilityState(page.cdpClient, state);
  console.log(`Session ${session.id}: visibility set to ${state}`);
}

type AuthPage = Pick<Page, 'setExtraHTTPHeaders' | 'setCookie' | 'deleteCookie'>;

async function runAuthCommand(
  action: AuthAction,
  options: EnvOptions,
  page: AuthPage,
  session: SessionData,
  existingEnv: EnvSettings
): Promise<EnvSettings> {
  const existingAuth = existingEnv.auth ?? {};

  if (action === 'clear') {
    // Best-effort courtesy: clear headers on the live CDP session and
    // delete any persisted cookies from the live session too.
    await page.setExtraHTTPHeaders({});
    for (const cookie of existingAuth.cookies ?? []) {
      await page.deleteCookie({ name: cookie.name, domain: cookie.domain, path: cookie.path });
    }
    console.log(`Session ${session.id}: auth settings cleared`);
    return { ...existingEnv, auth: undefined };
  }

  if (action === 'set-headers') {
    if (!options.authFromEnv || Object.keys(options.authFromEnv).length === 0) {
      throw new Error('auth set-headers requires at least one --from-env HeaderName=ENV_VAR');
    }

    // CDP's Network.setExtraHTTPHeaders replaces the entire header set, so we
    // must resolve and apply the full *merged* fromEnv map (existing +
    // newly-passed), not just the newly-passed headers. Otherwise previously
    // applied headers would silently drop from the live session even though
    // they remain persisted, until the next attach/reattach.
    const mergedFromEnv = { ...existingAuth.extraHeaders?.fromEnv, ...options.authFromEnv };

    const headers: Record<string, string> = {};
    const unsetVars: string[] = [];
    for (const [headerName, envVarName] of Object.entries(mergedFromEnv)) {
      const resolved = getEnv(envVarName);
      if (resolved !== undefined) {
        headers[headerName] = resolved;
      } else {
        unsetVars.push(envVarName);
      }
    }
    await page.setExtraHTTPHeaders(headers);

    const nextAuth: EnvSettings['auth'] = {
      ...existingAuth,
      extraHeaders: {
        ...existingAuth.extraHeaders,
        fromEnv: mergedFromEnv,
      },
    };
    if (unsetVars.length > 0) {
      console.warn(
        `Warning: env var(s) not set, header(s) will be applied on next attach once set: ${unsetVars.join(', ')}`
      );
    }
    console.log(
      `Session ${session.id}: applied and persisted headers from env: ${Object.keys(options.authFromEnv).join(', ')}`
    );
    return { ...existingEnv, auth: nextAuth };
  }

  if (action === 'set-cookie') {
    if (!options.authCookieName) {
      throw new Error(
        'auth set-cookie requires a cookie name, e.g. bp env auth set-cookie CF_Authorization --value-from-env CF_ACCESS_JWT'
      );
    }
    if (!options.authValueFromEnv) {
      throw new Error('auth set-cookie requires --value-from-env ENV_VAR');
    }

    const value = getEnv(options.authValueFromEnv);
    if (value === undefined) {
      throw new Error(`Environment variable ${options.authValueFromEnv} is not set`);
    }

    await page.setCookie({
      name: options.authCookieName,
      value,
      domain: options.authDomain,
      path: options.authPath,
      secure: options.authSecure,
    });

    const nextCookie = {
      name: options.authCookieName,
      valueFromEnv: options.authValueFromEnv,
      domain: options.authDomain,
      path: options.authPath,
      secure: options.authSecure,
    };
    const nextCookies = [
      ...(existingAuth.cookies ?? []).filter((c) => c.name !== options.authCookieName),
      nextCookie,
    ];

    console.log(`Session ${session.id}: applied and persisted cookie ${options.authCookieName}`);
    return { ...existingEnv, auth: { ...existingAuth, cookies: nextCookies } };
  }

  throw new Error(`Unsupported auth action: ${action}`);
}

function shortenHome(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function uniqueDomains(cookies: { domain: string }[]): string[] {
  return [...new Set(cookies.map((cookie) => cookie.domain))].sort();
}

function formatCookieStateErrorMessage(error: CookieStateError, ref: string): string {
  switch (error.code) {
    case 'already_exists':
      return `Snapshot already exists: ${ref} (use --force to overwrite)`;
    case 'not_found':
      return `Snapshot not found: ${ref}`;
    case 'invalid_format':
      return `Invalid snapshot reference or file format: ${error.message}`;
    case 'empty':
      return 'No cookies matched the capture scope; nothing was saved';
    case 'io_error':
      return `Failed to read/write snapshot file: ${error.message}`;
    default:
      return error.message;
  }
}

/** `bp env auth inspect <ref>` - fully offline, no browser/session, no cookie values. */
async function runAuthInspectCommand(ref: string, outputAsJson: boolean): Promise<void> {
  let resolvedPath: string;
  try {
    resolvedPath = resolveCookieStateRef(ref);
  } catch (error) {
    if (error instanceof CookieStateError) {
      throw new Error(formatCookieStateErrorMessage(error, ref));
    }
    throw error;
  }

  let state: Awaited<ReturnType<typeof loadCookieStateFile>>;
  try {
    state = await loadCookieStateFile(ref);
  } catch (error) {
    if (error instanceof CookieStateError) {
      throw new Error(formatCookieStateErrorMessage(error, ref));
    }
    throw error;
  }

  const domains = uniqueDomains(state.cookies);
  const summary = {
    file: shortenHome(resolvedPath),
    sourceUrl: state.sourceUrl,
    savedAt: state.savedAt,
    cookieCount: state.cookies.length,
    domains,
  };

  if (outputAsJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`File: ${summary.file}`);
  console.log(`Source URL: ${summary.sourceUrl}`);
  console.log(`Saved at: ${summary.savedAt}`);
  console.log(`Cookies: ${summary.cookieCount}`);
  console.log(`Domains: ${domains.join(', ')}`);
}

/** `bp env auth save <ref> -s <session>` - requires an explicit session, no auto-connect. */
async function runAuthSaveCommand(
  ref: string,
  options: EnvOptions,
  page: { cdpClient: Page['cdpClient']; targetId: Page['targetId']; url: Page['url'] },
  outputAsJson: boolean
): Promise<void> {
  let state: Awaited<ReturnType<typeof captureCookieState>>;
  try {
    state = await captureCookieState(page, { includeUrls: options.authIncludeUrls ?? [] });
  } catch (error) {
    if (error instanceof CookieStateError) {
      throw new Error(formatCookieStateErrorMessage(error, ref));
    }
    throw error;
  }

  let saved: { path: string };
  try {
    saved = await saveCookieStateFile(ref, state, { overwrite: options.authForce ?? false });
  } catch (error) {
    if (error instanceof CookieStateError) {
      throw new Error(formatCookieStateErrorMessage(error, ref));
    }
    throw error;
  }

  const summary = {
    file: shortenHome(saved.path),
    sourceUrl: state.sourceUrl,
    cookieCount: state.cookies.length,
  };

  if (outputAsJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Saved cookie snapshot: ${summary.file}`);
  console.log(`Source URL: ${summary.sourceUrl}`);
  console.log(`Cookies: ${summary.cookieCount}`);
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
  console.log(
    `Session ${session.id}: geolocation set to ${options.lat}, ${options.lon} (accuracy ${options.accuracy ?? 1})`
  );
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

  const outputAsJson = globalOptions.format === 'json';

  // `auth inspect` is fully offline: no connection, no session file, ever.
  if (options.topCommand === 'auth' && options.authAction === 'inspect') {
    if (!options.authRef) {
      throw new Error('auth inspect requires a snapshot name or path');
    }
    await runAuthInspectCommand(options.authRef, outputAsJson);
    return;
  }

  // `auth save` requires an explicit session; never auto-connect.
  if (options.topCommand === 'auth' && options.authAction === 'save') {
    if (!globalOptions.session && !options.useLatestSession) {
      throw new Error(
        'auth save requires an explicit session: use -s <session> or bare -s for the latest session'
      );
    }
    if (!options.authRef) {
      throw new Error('auth save requires a snapshot name or path');
    }
  }

  const {
    browser,
    session,
    page: resolvedPage,
  } = await resolveConnection(globalOptions.session, options.useLatestSession ?? false);
  const page = resolvedPage ?? (await browser.page(undefined, { targetId: session.targetId }));
  const existingEnv: EnvSettings = session.metadata?.env ?? {};

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
                    : [normalizeStoredPermission(options.permissionName)].filter(
                        isStoredPermissionName
                      );
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
        console.log(
          JSON.stringify(
            { session: session.id, action: permissionMode, permissions: result },
            null,
            2
          )
        );
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
      validateNetworkOptions(action, options);
      await runNetworkCommand(action, options, page, session);
      await updateSession(session.id, {
        metadata: {
          env: {
            ...existingEnv,
            network: networkSettingsFor(action, options),
          },
        },
      });
      if (options.recreateTab && action === 'online') {
        await recreateTab(page, session, browser);
      }
      if (options.duration && options.duration > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.duration));
        if (action === 'offline' || action === 'throttle') {
          await runNetworkCommand('online', {}, page, session);
          // Re-read the session immediately before the restore write: a
          // concurrent `bp env` command may have changed other env fields
          // (permissions, auth, etc.) while this command was asleep for
          // --duration, and spreading the pre-sleep `existingEnv` here would
          // silently clobber that change.
          const freshSession = await loadSession(session.id);
          const freshEnv: EnvSettings = freshSession.metadata?.env ?? {};
          await updateSession(session.id, {
            metadata: {
              env: {
                ...freshEnv,
                network: networkSettingsFor('online', {}),
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

    if (options.topCommand === 'auth') {
      if (!options.authAction) {
        throw new Error('auth command requires: set-headers, set-cookie, clear, save, or inspect');
      }
      if (options.authAction === 'save') {
        await runAuthSaveCommand(options.authRef!, options, page, outputAsJson);
        return;
      }
      const nextEnv = await runAuthCommand(options.authAction, options, page, session, existingEnv);
      await updateSession(session.id, { metadata: { env: nextEnv } });
      return;
    }

    throw new Error('Unknown env command. Run bp env --help for usage.');
  } finally {
    await browser.disconnect();
  }
}
