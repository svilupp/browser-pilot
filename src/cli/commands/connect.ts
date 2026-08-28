/**
 * Connect command - Create or resume a browser session
 *
 * By default, spawns a daemon process that holds the CDP WebSocket open
 * for faster subsequent commands. Use --no-daemon to disable.
 */

import { stopDaemon } from '../../daemon/lifecycle.ts';
import {
  connectionKeyForBrowser,
  daemonIdForConnection,
  endpointFingerprint,
  writeDaemonDescriptor,
} from '../../daemon/registry.ts';
import { type BrowserOptions, connect, mintCfAccessJwt, type Page } from '../../index.ts';
import { getEnv, isDaemonDisabledByEnv } from '../../runtime/env.ts';
import { getBuildProvenance } from '../../runtime/provenance.ts';
import { attachSession } from '../attach.ts';
import { formatBrowserDiscoveryError, resolveCLIEndpoint } from '../browser-endpoint.ts';
import { createLocalSession } from '../connect-service.ts';
import { spawnDaemon, waitForDaemonReady } from '../daemon-spawn.ts';
import { output } from '../output.ts';
import {
  createSession,
  deleteSession,
  type EnvSettings,
  generateSessionId,
  getSessionFilePath,
  loadSession,
  type ProviderType,
  type RecordSettings,
  type SessionData,
  saveSession,
  sessionExists,
  updateSession,
} from '../session.ts';

const CONNECT_HELP = `
bp connect - Create or resume a browser session

When to use:
  Create a session before running inspect, exec, record, trace, audio, or env commands.

When not to use:
  You already have a session and only need to open a page. Use \`bp exec '{"action":"goto","url":"..."}'\`.

Browser and page URL guidance:
  Use \`--browser-url\` for a DevTools WebSocket endpoint.
  Use \`--page-url\` to open a page in the attached tab or a new tab.
  \`--url\` remains for compatibility and is ambiguous when paired with \`--new-tab\`.

Usage:
  bp connect [options]

Local options:
  -p, --provider <type>   Provider: generic | browserbase | browserless | browser-use (default: generic)
  --browser-url <ws-url>  Explicit browser WebSocket URL (preferred)
  --page-url <url>        Page URL to open in the attached tab/new tab (preferred)
  --url <value>           Compatibility shorthand; browser URL, or page URL with --new-tab
  --channel <name>        Local Chrome channel: stable | beta | dev | canary
  --user-data-dir <path>  Explicit local Chrome user data dir for auto-discovery
  -n, --name <id>         Custom session name (default: auto-generated)
  -r, --resume <id>       Resume an existing session by ID
  -s, --session <id>      Alias for --resume
  --new-tab               Create and attach to a fresh tab instead of reusing an existing one
  --foreground            With --new-tab, opt into foregrounding the created tab
  --target-url <str>      Filter targets to those whose URL contains this string
  --api-key <key>         API key for cloud providers
  --project-id <id>       Project ID for BrowserBase provider
  --proxy-country <code>  Proxy country code for browser-use (default: uk)
  --profile-id <id>       Browser profile ID for browser-use
  --cloud-timeout <mins>  Session timeout in minutes for browser-use (max 240)
  --export-log <path>     Export session log to file on close
  --record                Enable screenshot recording for all subsequent exec calls
  --record-format <fmt>   Screenshot format: webp (default), png, jpeg
  --record-quality <n>    Quality 0-100 (default: 40)
  --no-highlights         Disable visual highlights on screenshots
  --no-daemon             Skip daemon creation (direct WebSocket only)
  BROWSER_PILOT_NO_DAEMON=1
                          Environment equivalent for CI and hermetic runs
  --daemon-idle <mins>    Opt-in daemon idle timeout in minutes (0 disables)
  --cf-access             Authenticate against Cloudflare Access using
                          CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET from the
                          environment. In cookie mode (default), mints the JWT
                          against --page-url when given (falling back to the
                          resolved page URL) and re-navigates afterward so the
                          first load succeeds (see
                          docs/proposals/cloudflare-access-auth.md)
  --cf-access-mode <m>    cookie (default, out-of-band JWT exchange) | headers
                          (persist raw service-token headers, global blast radius)

Global options:
  --json                  Output JSON
  --pretty                Output readable text (default)
  --debug                 Enable CDP transport debugging
  -h, --help              Show this help

Examples:
  bp connect                                     # Auto-connect to local Chrome
  bp connect --name dev                          # Auto-connect with a custom session name
  bp connect --resume dev                        # Resume a previous session
  bp connect --browser-url ws://localhost:9222/devtools/browser/abc123
  bp connect --channel beta                      # Narrow auto-discovery to Chrome Beta
  bp connect --user-data-dir ~/tmp/chrome-dev    # Use a specific Chrome profile
  bp connect --target-url localhost:3000         # Attach to tab matching URL
  bp connect --record                            # Connect with session-level recording
  bp connect --new-tab --page-url https://example.com
  bp connect --no-daemon                         # Connect without daemon (file-based only)
  bp connect --provider browser-use                              # UK proxy (default)
  bp connect --provider browser-use --proxy-country de           # German proxy
  bp connect --provider browser-use --proxy-country null         # No proxy
  bp connect --provider browser-use --cloud-timeout 30           # 30-min session
  bp connect --new-tab --page-url https://app.example.com --cf-access      # Cloudflare Access, cookie mode
  bp connect --new-tab --page-url https://app.example.com --cf-access --cf-access-mode headers

Likely next commands:
  bp exec -s dev '{"action":"goto","url":"https://example.com"}'
  bp snapshot -i -s dev
  bp text -s dev
`.trimEnd();

interface ConnectOptions {
  provider?: ProviderType;
  url?: string;
  browserUrl?: string;
  channel?: BrowserOptions['channel'];
  userDataDir?: string;
  pageUrl?: string;
  name?: string;
  resume?: string;
  newTab?: boolean;
  foreground?: boolean;
  targetUrl?: string;
  apiKey?: string;
  projectId?: string;
  exportLog?: string;
  proxyCountry?: string | null;
  profileId?: string;
  cloudTimeout?: number;
  noDaemon?: boolean;
  daemonIdleMins?: number;
  record?: boolean;
  recordFormat?: 'png' | 'jpeg' | 'webp';
  recordQuality?: number;
  noHighlights?: boolean;
  cfAccess?: boolean;
  cfAccessMode?: 'headers' | 'cookie';
}

async function resolveInitialPageUrl(
  page: { url(): Promise<string> },
  requestedUrl?: string
): Promise<string> {
  const initialUrl = await page.url();

  if (!requestedUrl || requestedUrl === 'about:blank' || initialUrl !== 'about:blank') {
    return initialUrl;
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await Bun.sleep(100);
    const currentUrl = await page.url();
    if (currentUrl !== 'about:blank') {
      return currentUrl;
    }
  }

  return initialUrl;
}

function parseConnectArgs(args: string[]): ConnectOptions {
  const options: ConnectOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--provider' || arg === '-p') {
      const p = args[++i];
      if (p !== 'browserbase' && p !== 'browserless' && p !== 'browser-use' && p !== 'generic') {
        throw new Error(
          `Invalid provider: ${p}. Must be one of: browserbase, browserless, browser-use, generic`
        );
      }
      options.provider = p;
    } else if (arg === '--url') {
      options.url = args[++i];
    } else if (arg === '--browser-url') {
      options.browserUrl = args[++i];
    } else if (arg === '--channel') {
      const channel = args[++i];
      if (channel !== 'stable' && channel !== 'beta' && channel !== 'dev' && channel !== 'canary') {
        throw new Error('--channel must be one of: stable, beta, dev, canary');
      }
      options.channel = channel;
    } else if (arg === '--user-data-dir') {
      options.userDataDir = args[++i];
    } else if (arg === '--page-url') {
      options.pageUrl = args[++i];
    } else if (arg === '--name' || arg === '-n') {
      options.name = args[++i];
    } else if (arg === '--resume' || arg === '-r') {
      options.resume = args[++i];
    } else if (arg === '--new-tab') {
      options.newTab = true;
    } else if (arg === '--foreground') {
      options.foreground = true;
    } else if (arg === '--target-url') {
      options.targetUrl = args[++i];
    } else if (arg === '--api-key') {
      options.apiKey = args[++i];
    } else if (arg === '--project-id') {
      options.projectId = args[++i];
    } else if (arg === '--export-log') {
      options.exportLog = args[++i];
    } else if (arg === '--record') {
      options.record = true;
    } else if (arg === '--record-format') {
      const fmt = args[++i];
      if (fmt !== 'png' && fmt !== 'jpeg' && fmt !== 'webp') {
        throw new Error('--record-format must be "png", "jpeg", or "webp"');
      }
      options.recordFormat = fmt;
      options.record = true;
    } else if (arg === '--record-quality') {
      const q = parseInt(args[++i] ?? '', 10);
      if (Number.isNaN(q) || q < 0 || q > 100) {
        throw new Error('--record-quality must be 0-100');
      }
      options.recordQuality = q;
      options.record = true;
    } else if (arg === '--no-highlights') {
      options.noHighlights = true;
    } else if (arg === '--no-daemon') {
      options.noDaemon = true;
    } else if (arg === '--daemon-idle') {
      const idleMins = parseInt(args[++i] ?? '0', 10);
      if (Number.isNaN(idleMins) || idleMins < 0) {
        throw new Error('--daemon-idle must be 0 or a positive number of minutes');
      }
      options.daemonIdleMins = idleMins;
    } else if (arg === '--proxy-country') {
      const val = args[++i];
      options.proxyCountry = val === 'null' ? null : val;
    } else if (arg === '--profile-id') {
      options.profileId = args[++i];
    } else if (arg === '--cloud-timeout') {
      const mins = parseInt(args[++i] ?? '', 10);
      if (Number.isNaN(mins) || mins < 1 || mins > 240) {
        throw new Error('--cloud-timeout must be 1-240 minutes');
      }
      options.cloudTimeout = mins;
    } else if (arg === '--cf-access') {
      options.cfAccess = true;
    } else if (arg === '--cf-access-mode') {
      const mode = args[++i];
      if (mode !== 'headers' && mode !== 'cookie') {
        throw new Error('--cf-access-mode must be "headers" or "cookie"');
      }
      options.cfAccessMode = mode;
    }
  }

  return options;
}

export async function connectCommand(
  args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  if (globalOptions.help) {
    console.log(CONNECT_HELP);
    return;
  }

  const options = parseConnectArgs(args);

  // Resume existing session
  if (options.resume || globalOptions.session) {
    const sessionId = options.resume || globalOptions.session!;
    let session = await loadSession(sessionId);

    if (session.transport?.mode === 'daemon') {
      // Resume through the same attachment path as every other stored-session
      // command. It validates the daemon control plane and performs one
      // bounded recovery (including endpoint re-resolution after Chrome
      // restarts) instead of merely checking the old PID.
      const attached = await attachSession(session, { trace: globalOptions.trace });
      await attached.browser.disconnect();
      session = await loadSession(session.id);
    }

    // Update recording settings on resumed session if --record is passed
    if (options.record) {
      const recordSettings: RecordSettings = {};
      if (options.recordFormat) recordSettings.format = options.recordFormat;
      if (options.recordQuality !== undefined) recordSettings.quality = options.recordQuality;
      if (options.noHighlights) recordSettings.highlights = false;
      session = await updateSession(sessionId, { metadata: { record: recordSettings } });
    }

    output(
      {
        success: true,
        resumed: true,
        sessionId: session.id,
        provider: session.provider,
        currentUrl: session.currentUrl,
        recording: !!session.metadata?.record,
        transport: session.transport?.mode ?? (session.daemon ? 'daemon' : 'direct'),
        daemon: session.daemon
          ? { pid: session.daemon.pid, socketPath: session.daemon.socketPath }
          : undefined,
      },
      globalOptions.format
    );
    return;
  }

  // Determine provider and connection details
  const provider: ProviderType = options.provider ?? 'generic';
  let wsUrl = options.browserUrl ?? options.url;
  let pageUrl = options.pageUrl;
  let connectionSource: 'explicit-ws' | 'devtools-active-port' | 'json-version' | undefined;
  let resolvedChannel: BrowserOptions['channel'] | 'custom' | undefined;
  let resolvedUserDataDir: string | undefined;

  if (
    options.newTab &&
    options.url &&
    !options.url.startsWith('ws://') &&
    !options.url.startsWith('wss://')
  ) {
    pageUrl = options.url;
    if (!options.browserUrl) {
      wsUrl = undefined;
    }
  }

  // Auto-discover WebSocket URL for generic provider
  if (provider === 'generic' && !wsUrl) {
    try {
      const resolved = await resolveCLIEndpoint({
        explicitWsUrl: wsUrl,
        channel: options.channel,
        userDataDir: options.userDataDir,
      });
      wsUrl = resolved.wsUrl;
      connectionSource = resolved.source;
      resolvedChannel = resolved.channel;
      resolvedUserDataDir = resolved.userDataDir;
    } catch (error) {
      throw new Error(
        formatBrowserDiscoveryError(error, {
          explicitFlag: '--browser-url',
        })
      );
    }
  } else if (wsUrl) {
    connectionSource = 'explicit-ws';
  }

  // Allocate the session ID before opening the browser. In daemon mode the
  // provisional session record is the daemon's bootstrap contract, allowing
  // it to own the first CDP WebSocket rather than reconnecting after CLI use.
  const sessionId = options.name ?? generateSessionId();
  if (await sessionExists(sessionId)) {
    throw new Error(`Session already exists: ${sessionId}. Use --resume or close it first.`);
  }

  // Build connection options
  const connectOptions: BrowserOptions = {
    provider,
    debug: globalOptions.trace,
    wsUrl,
    channel: options.channel,
    userDataDir: options.userDataDir,
    apiKey: options.apiKey,
    projectId: options.projectId,
    proxyCountryCode: options.proxyCountry,
    profileId: options.profileId,
    cloudTimeout: options.cloudTimeout,
  };

  // Generic/local sessions can be daemon-first because discovery already gave
  // us a browser-level WebSocket URL. Cloud providers still need their normal
  // provider handshake before a daemon can be started.
  const daemonDisabledByEnv = isDaemonDisabledByEnv();
  const useDaemon = !options.noDaemon && !daemonDisabledByEnv && provider === 'generic' && !!wsUrl;
  let daemonSession: SessionData | undefined;
  let sessionDaemonId: string | undefined;
  let browser!: Awaited<ReturnType<typeof connect>>;
  let page: Page;

  if (useDaemon) {
    try {
      const created = await createLocalSession({
        wsUrl: wsUrl!,
        trace: globalOptions.trace,
        name: sessionId,
        newTab: options.newTab,
        pageUrl,
        targetUrl: options.targetUrl,
        foreground: options.foreground,
        daemonIdleMins: options.daemonIdleMins,
        connectionSource,
        resolvedChannel,
        resolvedUserDataDir,
        metadata: { provenance: getBuildProvenance() },
      });
      browser = created.browser;
      page = created.page;
      daemonSession = created.session;
      sessionDaemonId =
        created.session.transport?.mode === 'daemon'
          ? created.session.transport.daemonId
          : undefined;
    } catch (error) {
      if (browser?.isConnected) {
        await browser.disconnect().catch(() => {});
      }
      throw new Error(
        `Could not start the session daemon: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } else {
    browser = await connect(connectOptions);
    page = options.newTab
      ? await browser.newPage(pageUrl ?? 'about:blank', { background: options.foreground !== true })
      : await browser.page(
          undefined,
          options.targetUrl !== undefined ? { targetUrl: options.targetUrl } : undefined
        );
  }
  let currentUrl = await resolveInitialPageUrl(page, pageUrl);

  if (browser.metadata?.['liveUrl']) {
    console.error(`\nLive viewer: ${browser.metadata['liveUrl']}\n`);
  }

  // Apply Cloudflare Access sugar (--cf-access) before persisting the session,
  // so the resulting EnvSettings.auth is reapplied on every attach/reattach.
  let cfAccessAuth: EnvSettings['auth'] | undefined;
  if (options.cfAccess) {
    const mode = options.cfAccessMode ?? 'cookie';
    if (currentUrl === 'about:blank') {
      throw new Error(
        '--cf-access requires a target URL. Pass --page-url <url> (with --new-tab) or --url <url>.'
      );
    }

    const clientId = getEnv('CF_ACCESS_CLIENT_ID');
    const clientSecret = getEnv('CF_ACCESS_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new Error(
        '--cf-access requires CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to be set in the environment.'
      );
    }

    if (mode === 'headers') {
      await page.setExtraHTTPHeaders({
        'CF-Access-Client-Id': clientId,
        'CF-Access-Client-Secret': clientSecret,
      });
      cfAccessAuth = {
        extraHeaders: {
          fromEnv: {
            'CF-Access-Client-Id': 'CF_ACCESS_CLIENT_ID',
            'CF-Access-Client-Secret': 'CF_ACCESS_CLIENT_SECRET',
          },
        },
      };
    } else {
      // Mint against the explicit --page-url when given, not the possibly-racy
      // currentUrl resolved from polling: on an Access-protected origin, the
      // page may still be sitting on the *.cloudflareaccess.com login
      // redirect when we sample the URL, which would mint the JWT against the
      // wrong origin/cookie domain.
      const mintUrl = pageUrl ?? currentUrl;
      const { cookie } = await mintCfAccessJwt({
        url: mintUrl,
        clientId,
        clientSecret,
      });
      await page.setCookie(cookie);
      // If we navigated before the cookie was set, the first load may have
      // hit the Access login redirect instead of the target origin. Re-issue
      // the navigation now that the cookie is in place so the session lands
      // on the intended page.
      if (pageUrl && pageUrl !== 'about:blank') {
        await page.goto(pageUrl);
        currentUrl = await page.url();
      }
      // The minted JWT is persisted by design (proposal §3): it expires per
      // the Access session policy, unlike a long-lived client secret.
      cfAccessAuth = { cookies: [{ ...cookie }] };
    }
  }

  // Build session-level recording settings if --record flag is set
  let recordSettings: RecordSettings | undefined;
  if (options.record) {
    recordSettings = {};
    if (options.recordFormat) recordSettings.format = options.recordFormat;
    if (options.recordQuality !== undefined) recordSettings.quality = options.recordQuality;
    if (options.noHighlights) recordSettings.highlights = false;
  }

  // Save session
  const session: SessionData = {
    id: sessionId,
    provider,
    wsUrl: browser.wsUrl,
    providerSessionId: browser.sessionId,
    targetId: page.targetId,
    exportLog: options.exportLog,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    currentUrl,
    daemon: daemonSession?.daemon,
    transport: useDaemon
      ? { mode: 'daemon', daemonId: sessionDaemonId }
      : {
          mode: 'direct',
          reason: options.noDaemon ? 'flag' : daemonDisabledByEnv ? 'environment' : 'legacy',
        },
    metadata: {
      ...browser.metadata,
      ...(connectionSource ? { connectionSource } : {}),
      ...(resolvedChannel ? { resolvedChannel } : {}),
      ...(resolvedUserDataDir ? { resolvedUserDataDir } : {}),
      ...(recordSettings ? { record: recordSettings } : {}),
      ...(cfAccessAuth ? { env: { auth: cfAccessAuth } } : {}),
      provenance: getBuildProvenance(),
    },
  };
  const outputMetadata = session.metadata;

  if (daemonSession) {
    await saveSession(session);
  } else {
    try {
      await createSession(session);
    } catch (error) {
      await browser.disconnect().catch(() => {});
      throw error;
    }
  }

  // Disconnect (session can be resumed via daemon or direct WebSocket)
  await browser.disconnect();

  // Spawn daemon unless --no-daemon
  let daemonResult: { pid: number; socketPath: string } | undefined;

  if (!options.noDaemon && !daemonDisabledByEnv && !useDaemon) {
    try {
      const idleTimeoutMs = options.daemonIdleMins ? options.daemonIdleMins * 60 * 1000 : undefined;

      const spawned = spawnDaemon(sessionId, idleTimeoutMs);

      // Wait for daemon to become ready (writes daemon info to session file)
      const ready = await waitForDaemonReady(getSessionFilePath(sessionId), spawned.pid);
      if (!ready) {
        await stopDaemon(spawned.pid).catch(() => false);
        throw new Error(`Daemon did not become ready within ${3000}ms (pid ${spawned.pid})`);
      }
      // Re-read session to get daemon info
      const updated = await loadSession(sessionId);
      if (updated.daemon) {
        const connectionKey = connectionKeyForBrowser({
          provider,
          wsUrl: updated.wsUrl,
          userDataDir: updated.metadata?.resolvedUserDataDir,
          ...(updated.metadata?.connectionSource === 'json-version'
            ? { legacyHost: new URL(updated.wsUrl).host }
            : {}),
          providerSessionId: updated.providerSessionId,
        });
        const daemonId = daemonIdForConnection(connectionKey);
        await updateSession(sessionId, { transport: { mode: 'daemon', daemonId } });
        await writeDaemonDescriptor({
          schemaVersion: 1,
          id: daemonId,
          connectionKey,
          endpointFingerprint: endpointFingerprint(updated.wsUrl),
          pid: updated.daemon.pid,
          socketPath: updated.daemon.socketPath,
          startedAt: updated.daemon.startedAt,
          ...(updated.daemon.heartbeatPath ? { heartbeatPath: updated.daemon.heartbeatPath } : {}),
        });
        daemonResult = {
          pid: updated.daemon.pid,
          socketPath: updated.daemon.socketPath,
        };
      }
    } catch (error) {
      // Do not silently downgrade a requested daemon session to a second
      // direct WebSocket connection; that is what caused repeated permission
      // prompts and makes lifecycle failures invisible.
      await deleteSession(sessionId).catch(() => {});
      throw new Error(
        `Could not start the session daemon: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (useDaemon && daemonSession?.daemon) {
    daemonResult = {
      pid: daemonSession.daemon.pid,
      socketPath: daemonSession.daemon.socketPath,
    };
  }

  output(
    {
      success: true,
      sessionId,
      provider,
      currentUrl,
      recording: !!recordSettings,
      transport: useDaemon ? 'daemon' : 'direct',
      connectionSource,
      resolvedChannel,
      resolvedUserDataDir,
      provenance: getBuildProvenance(),
      metadata: outputMetadata,
      daemon: daemonResult,
    },
    globalOptions.format
  );
}
