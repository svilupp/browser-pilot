import { createCDPClient } from '../cdp/index.ts';
import { getBrowserWebSocketUrl } from './generic.ts';

export type ChromeChannel = 'stable' | 'beta' | 'dev' | 'canary';
export type ResolvedBrowserSource = 'explicit-ws' | 'devtools-active-port' | 'json-version';

export interface LocalBrowserScanTarget {
  channel: ChromeChannel | 'custom';
  userDataDir: string;
  portFile: string;
}

export interface LocalBrowserCandidate extends LocalBrowserScanTarget {
  port: number;
  browserPath: string;
  wsUrl: string;
  browserVersion?: string;
}

export type LocalDiscoveryFailureReason =
  | 'missing-file'
  | 'unreadable-file'
  | 'malformed-file'
  | 'invalid-port'
  | 'invalid-path'
  | 'connection-refused'
  | 'connection-timeout'
  | 'unexpected-close'
  | 'connection-error'
  | 'cdp-error';

export interface LocalDiscoveryFailure extends LocalBrowserScanTarget {
  reason: LocalDiscoveryFailureReason;
  message: string;
  wsUrl?: string;
}

export interface LocalBrowserDiscoveryResult {
  candidates: LocalBrowserCandidate[];
  failures: LocalDiscoveryFailure[];
}

export interface ResolvedBrowserEndpoint {
  wsUrl: string;
  source: ResolvedBrowserSource;
  channel?: ChromeChannel | 'custom';
  userDataDir?: string;
}

export interface ChromeUserDataDirOptions {
  platform?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

export interface DiscoverLocalBrowsersOptions extends ChromeUserDataDirOptions {
  channel?: ChromeChannel;
  userDataDir?: string;
  probeTimeoutMs?: number;
  /**
   * Whether discovery may open a CDP WebSocket to validate a candidate.
   * `none` is side-effect-free and should be used by the CLI; `cdp` is kept
   * for library callers that explicitly want protocol validation.
   */
  probe?: 'none' | 'cdp';
}

export interface ResolveBrowserEndpointOptions extends DiscoverLocalBrowsersOptions {
  explicitWsUrl?: string;
  allowLocalDiscovery?: boolean;
  allowLegacyHostFallback?: boolean;
  legacyHost?: string;
}

interface ProbeResult {
  browserVersion?: string;
}

interface LocalDiscoveryDependencies {
  readTextFile(path: string): Promise<string>;
  probeBrowserWebSocket(wsUrl: string, timeoutMs: number): Promise<ProbeResult>;
  getLegacyBrowserWebSocketUrl(host: string): Promise<string>;
}

interface ParsedDevToolsActivePort {
  port: number;
  browserPath: string;
  wsUrl: string;
}

type DiscoveryOutcome =
  | { kind: 'candidate'; candidate: LocalBrowserCandidate }
  | { kind: 'failure'; failure: LocalDiscoveryFailure };

const CHANNEL_ORDER: ChromeChannel[] = ['stable', 'beta', 'dev', 'canary'];
const DEFAULT_PROBE_TIMEOUT_MS = 1000;

class DevToolsActivePortParseError extends Error {
  constructor(
    message: string,
    readonly reason: Extract<
      LocalDiscoveryFailureReason,
      'malformed-file' | 'invalid-port' | 'invalid-path'
    >
  ) {
    super(message);
    this.name = 'DevToolsActivePortParseError';
  }
}

function getRuntimeEnv(): Record<string, string | undefined> {
  if (typeof process === 'undefined') {
    return {};
  }
  return process.env;
}

function getRuntimePlatform(): string | undefined {
  if (typeof process === 'undefined') {
    return undefined;
  }
  return process.platform;
}

function normalizePlatform(platform: string | undefined): 'darwin' | 'linux' | 'win32' {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
    return platform;
  }
  throw new Error(`Unsupported platform: ${platform ?? 'unknown'}`);
}

function trimTrailingSeparator(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

function joinPath(platform: 'darwin' | 'linux' | 'win32', ...parts: string[]): string {
  const separator = platform === 'win32' ? '\\' : '/';
  const cleaned = parts
    .map((part, index) => {
      if (index === 0) return trimTrailingSeparator(part);
      return part.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
    })
    .filter((part) => part.length > 0);

  return cleaned.join(separator);
}

function resolveHomeDir(
  platform: 'darwin' | 'linux' | 'win32',
  env: Record<string, string | undefined>,
  explicitHomeDir?: string
): string {
  if (explicitHomeDir) {
    return explicitHomeDir;
  }

  if (platform === 'win32') {
    return env['USERPROFILE'] ?? env['HOME'] ?? '';
  }

  return env['HOME'] ?? env['USERPROFILE'] ?? '';
}

function toFileFailure(target: LocalBrowserScanTarget, error: unknown): LocalDiscoveryFailure {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  if (errno === 'ENOENT') {
    return {
      ...target,
      reason: 'missing-file',
      message: `DevToolsActivePort not found at ${target.portFile}`,
    };
  }

  return {
    ...target,
    reason: 'unreadable-file',
    message:
      error instanceof Error
        ? error.message
        : `Could not read DevToolsActivePort at ${target.portFile}`,
  };
}

function toProbeFailure(
  target: LocalBrowserScanTarget,
  wsUrl: string,
  error: unknown
): LocalDiscoveryFailure {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  let reason: Extract<
    LocalDiscoveryFailureReason,
    | 'connection-refused'
    | 'connection-timeout'
    | 'unexpected-close'
    | 'connection-error'
    | 'cdp-error'
  > = 'connection-error';

  if (lowerMessage.includes('refused') || lowerMessage.includes('econnrefused')) {
    reason = 'connection-refused';
  } else if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
    reason = 'connection-timeout';
  } else if (lowerMessage.includes('closed')) {
    reason = 'unexpected-close';
  } else if (
    lowerMessage.includes('browser.getversion') ||
    lowerMessage.includes('cdp') ||
    lowerMessage.includes('protocol')
  ) {
    reason = 'cdp-error';
  }

  return {
    ...target,
    wsUrl,
    reason,
    message,
  };
}

async function readTextFile(path: string): Promise<string> {
  const fs = await import('node:fs/promises');
  return fs.readFile(path, 'utf-8');
}

async function probeBrowserWebSocket(wsUrl: string, timeoutMs: number): Promise<ProbeResult> {
  let client: Awaited<ReturnType<typeof createCDPClient>> | undefined;
  try {
    client = await createCDPClient(wsUrl, { timeout: timeoutMs });
    const version = await client.send<{ product?: string }>('Browser.getVersion', undefined, null);
    return { browserVersion: version.product };
  } finally {
    await client?.close().catch(() => {});
  }
}

const defaultDependencies: LocalDiscoveryDependencies = {
  readTextFile,
  probeBrowserWebSocket,
  getLegacyBrowserWebSocketUrl: getBrowserWebSocketUrl,
};

export function resolveChromeUserDataDirs(
  options: ChromeUserDataDirOptions = {}
): Record<ChromeChannel, string> {
  const env = options.env ?? getRuntimeEnv();
  const platform = normalizePlatform(options.platform ?? getRuntimePlatform());
  const homeDir = resolveHomeDir(platform, env, options.homeDir);

  if (!homeDir) {
    throw new Error('Could not determine home directory for local Chrome discovery');
  }

  switch (platform) {
    case 'darwin': {
      const base = joinPath(platform, homeDir, 'Library', 'Application Support', 'Google');
      return {
        stable: joinPath(platform, base, 'Chrome'),
        beta: joinPath(platform, base, 'Chrome Beta'),
        dev: joinPath(platform, base, 'Chrome Dev'),
        canary: joinPath(platform, base, 'Chrome Canary'),
      };
    }

    case 'linux': {
      const configHome =
        env['CHROME_CONFIG_HOME'] ??
        env['XDG_CONFIG_HOME'] ??
        joinPath(platform, homeDir, '.config');
      return {
        stable: joinPath(platform, configHome, 'google-chrome'),
        beta: joinPath(platform, configHome, 'google-chrome-beta'),
        dev: joinPath(platform, configHome, 'google-chrome-dev'),
        canary: joinPath(platform, configHome, 'google-chrome-canary'),
      };
    }

    case 'win32': {
      const localAppData = env['LOCALAPPDATA'] ?? joinPath(platform, homeDir, 'AppData', 'Local');
      const base = joinPath(platform, localAppData, 'Google');
      return {
        stable: joinPath(platform, base, 'Chrome', 'User Data'),
        beta: joinPath(platform, base, 'Chrome Beta', 'User Data'),
        dev: joinPath(platform, base, 'Chrome Dev', 'User Data'),
        canary: joinPath(platform, base, 'Chrome SxS', 'User Data'),
      };
    }
  }

  throw new Error(`Unsupported platform for local Chrome discovery: ${platform}`);
}

export function buildLocalBrowserScanTargets(
  options: DiscoverLocalBrowsersOptions = {}
): LocalBrowserScanTarget[] {
  const env = options.env ?? getRuntimeEnv();
  const platform = normalizePlatform(options.platform ?? getRuntimePlatform());

  if (options.userDataDir) {
    return [
      {
        channel: options.channel ?? 'custom',
        userDataDir: options.userDataDir,
        portFile: joinPath(platform, options.userDataDir, 'DevToolsActivePort'),
      },
    ];
  }

  const dirs = resolveChromeUserDataDirs({
    platform,
    env,
    homeDir: options.homeDir,
  });
  const channels = options.channel ? [options.channel] : CHANNEL_ORDER;

  return channels.map((channel) => ({
    channel,
    userDataDir: dirs[channel],
    portFile: joinPath(platform, dirs[channel], 'DevToolsActivePort'),
  }));
}

export function parseDevToolsActivePortFile(content: string): ParsedDevToolsActivePort {
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length !== 2) {
    throw new DevToolsActivePortParseError(
      `Expected exactly 2 non-empty lines in DevToolsActivePort, got ${lines.length}`,
      'malformed-file'
    );
  }

  const portText = lines[0]!;
  const browserPath = lines[1]!;
  const port = Number.parseInt(portText, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DevToolsActivePortParseError(
      `Invalid DevToolsActivePort port: ${portText}`,
      'invalid-port'
    );
  }

  if (
    !browserPath.startsWith('/devtools/browser/') ||
    browserPath.includes('..') ||
    /[?#\s\\]/u.test(browserPath)
  ) {
    throw new DevToolsActivePortParseError(
      `Invalid DevToolsActivePort browser path: ${browserPath}`,
      'invalid-path'
    );
  }

  return {
    port,
    browserPath,
    wsUrl: `ws://127.0.0.1:${port}${browserPath}`,
  };
}

async function inspectScanTarget(
  target: LocalBrowserScanTarget,
  options: DiscoverLocalBrowsersOptions,
  deps: LocalDiscoveryDependencies
): Promise<DiscoveryOutcome> {
  let content: string;

  try {
    content = await deps.readTextFile(target.portFile);
  } catch (error) {
    return { kind: 'failure', failure: toFileFailure(target, error) };
  }

  let parsed: ParsedDevToolsActivePort;
  try {
    parsed = parseDevToolsActivePortFile(content);
  } catch (error) {
    if (error instanceof DevToolsActivePortParseError) {
      return {
        kind: 'failure',
        failure: {
          ...target,
          reason: error.reason,
          message: error.message,
        },
      };
    }
    throw error;
  }

  if (options.probe === 'none') {
    return {
      kind: 'candidate',
      candidate: {
        ...target,
        port: parsed.port,
        browserPath: parsed.browserPath,
        wsUrl: parsed.wsUrl,
      },
    };
  }

  try {
    const probe = await deps.probeBrowserWebSocket(
      parsed.wsUrl,
      options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    );
    return {
      kind: 'candidate',
      candidate: {
        ...target,
        port: parsed.port,
        browserPath: parsed.browserPath,
        wsUrl: parsed.wsUrl,
        browserVersion: probe.browserVersion,
      },
    };
  } catch (error) {
    return {
      kind: 'failure',
      failure: toProbeFailure(target, parsed.wsUrl, error),
    };
  }
}

export async function discoverLocalBrowsers(
  options: DiscoverLocalBrowsersOptions = {},
  deps: LocalDiscoveryDependencies = defaultDependencies
): Promise<LocalBrowserDiscoveryResult> {
  const scanTargets = buildLocalBrowserScanTargets(options);
  // CDP probes are intentionally serialized. Opening several speculative
  // browser WebSockets at once can trigger multiple remote-debugging consent
  // prompts before the resolver has established which profile to use.
  const outcomes: DiscoveryOutcome[] = [];
  if (options.probe !== 'none') {
    for (const target of scanTargets) {
      outcomes.push(await inspectScanTarget(target, options, deps));
    }
  } else {
    outcomes.push(
      ...(await Promise.all(scanTargets.map((target) => inspectScanTarget(target, options, deps))))
    );
  }

  const candidates: LocalBrowserCandidate[] = [];
  const failures: LocalDiscoveryFailure[] = [];

  for (const outcome of outcomes) {
    if (outcome.kind === 'candidate') {
      candidates.push(outcome.candidate);
    } else {
      failures.push(outcome.failure);
    }
  }

  return { candidates, failures };
}

export type BrowserEndpointResolutionErrorCode = 'multiple-local-browsers' | 'browser-not-found';

export class BrowserEndpointResolutionError extends Error {
  override readonly name = 'BrowserEndpointResolutionError';

  constructor(
    readonly code: BrowserEndpointResolutionErrorCode,
    message: string,
    readonly details: {
      candidates?: LocalBrowserCandidate[];
      failures?: LocalDiscoveryFailure[];
      legacyError?: Error;
      legacyHost?: string;
    } = {}
  ) {
    super(message);
  }
}

export async function resolveBrowserEndpoint(
  options: ResolveBrowserEndpointOptions = {},
  deps: LocalDiscoveryDependencies = defaultDependencies
): Promise<ResolvedBrowserEndpoint> {
  if (options.explicitWsUrl) {
    return {
      wsUrl: options.explicitWsUrl,
      source: 'explicit-ws',
    };
  }

  let localDiscovery: LocalBrowserDiscoveryResult | undefined;

  if (options.allowLocalDiscovery ?? true) {
    // Read every candidate without touching CDP first. This lets the resolver
    // return an actionable multiple-profile error before any speculative
    // WebSocket handshake. A protocol probe, when explicitly requested, is
    // performed only after exactly one candidate remains.
    const probeRequested = options.probe !== 'none';
    localDiscovery = await discoverLocalBrowsers(
      probeRequested ? { ...options, probe: 'none' } : options,
      deps
    );

    if (probeRequested && localDiscovery.candidates.length === 1) {
      const candidate = localDiscovery.candidates[0]!;
      try {
        const probe = await deps.probeBrowserWebSocket(
          candidate.wsUrl,
          options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
        );
        candidate.browserVersion = probe.browserVersion;
      } catch (error) {
        localDiscovery = {
          candidates: [],
          failures: [
            toProbeFailure(
              {
                channel: candidate.channel,
                userDataDir: candidate.userDataDir,
                portFile: candidate.portFile,
              },
              candidate.wsUrl,
              error
            ),
          ],
        };
      }
    }

    if (localDiscovery.candidates.length === 1) {
      const candidate = localDiscovery.candidates[0]!;
      return {
        wsUrl: candidate.wsUrl,
        source: 'devtools-active-port',
        channel: candidate.channel,
        userDataDir: candidate.userDataDir,
      };
    }

    if (localDiscovery.candidates.length > 1) {
      throw new BrowserEndpointResolutionError(
        'multiple-local-browsers',
        'Multiple local Chrome profiles are available for auto-discovery',
        {
          candidates: localDiscovery.candidates,
          failures: localDiscovery.failures,
        }
      );
    }
  }

  if (options.allowLegacyHostFallback ?? true) {
    const legacyHost = options.legacyHost ?? 'localhost:9222';

    try {
      return {
        wsUrl: await deps.getLegacyBrowserWebSocketUrl(legacyHost),
        source: 'json-version',
      };
    } catch (error) {
      throw new BrowserEndpointResolutionError(
        'browser-not-found',
        'Could not resolve a browser endpoint',
        {
          candidates: localDiscovery?.candidates,
          failures: localDiscovery?.failures,
          legacyError: error instanceof Error ? error : new Error(String(error)),
          legacyHost,
        }
      );
    }
  }

  throw new BrowserEndpointResolutionError(
    'browser-not-found',
    'Could not resolve a browser endpoint',
    {
      candidates: localDiscovery?.candidates,
      failures: localDiscovery?.failures,
    }
  );
}
