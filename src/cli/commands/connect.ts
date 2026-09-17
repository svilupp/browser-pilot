/**
 * Connect command - Create or resume a browser session
 *
 * By default, spawns a daemon process that holds the CDP WebSocket open
 * for faster subsequent commands. Use --no-daemon to disable.
 */

import { homedir } from 'node:os';
import {
  loadCookieStateFile,
  resolveCookieStateRef,
} from '../../adapters/node/cookie-state-files.ts';
import { domainMatches, hostFromUrl } from '../../auth/cookie-scope.ts';
import { restoreCookieState } from '../../auth/cookie-state.ts';
import type { CookieState } from '../../auth/types.ts';
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
  -p, --provider <type>   Provider: generic | browserbase | browser-use (default: generic)
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
  --auth <name-or-path>   Restore a saved cookie snapshot into a fresh tab before
                          navigation. Implies --new-tab. Conflicts with --resume,
                          -s, --target-url. Env fallback: BROWSER_PILOT_AUTH (name-or-path
                          resolved identically to --auth; --auth wins when both are set;
                          prints "auth: using BROWSER_PILOT_AUTH → <resolved path>").
                          Compatible with --page-url (overrides the snapshot's saved
                          source URL) and --cf-access (restore → mint → single navigation).
                          See docs/guides/auth-cookies.md.
  --api-key <key>         API key for cloud providers. Falls back to
                          BROWSERBASE_API_KEY / BROWSER_USE_API_KEY depending on --provider
  --project-id <id>       Project ID for BrowserBase provider (optional;
                          falls back to BROWSERBASE_PROJECT_ID, and is
                          auto-resolved from the API key when omitted)
  --proxy-country <code>  Proxy country code for browser-use (default: uk)
  --profile-id <id>       Browser profile ID for browser-use
  --cloud-timeout <mins>  Session timeout in minutes for browser-use (max 240)
  Browserbase sessions use keepAlive: true for reconnection (requires a paid plan).
  Browserless launch URLs cannot be reused by CLI sessions; use the direct library.
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
                          docs/guides/auth-cookies.md)
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
  auth?: string;
}

/** Shorten an absolute path under $HOME to a `~`-prefixed path for display/metadata. */
function shortenHome(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
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
    } else if (arg === '--auth') {
      options.auth = args[++i];
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

  if (options.auth && (options.resume || globalOptions.session)) {
    throw new Error(
      '--auth conflicts with --resume/-s. Cookie snapshots are restored only when creating a new session.'
    );
  }
  if (options.auth && options.targetUrl) {
    throw new Error('--auth conflicts with --target-url.');
  }

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
  if (provider === 'browserless') {
    throw new Error(
      'CLI sessions cannot reconnect Browserless launch URLs. Use the direct browser library, or a generic endpoint whose reconnection lifecycle is managed by your host.'
    );
  }

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

  // --auth: resolve/load the cookie snapshot before any provider/session
  // creation so an invalid ref fails fast, before a browser is touched.
  // Env fallback only applies when --auth is absent (never on resume, which
  // already returned above).
  let authRef = options.auth;
  let authFromEnv = false;
  if (!authRef) {
    const envAuth = getEnv('BROWSER_PILOT_AUTH');
    if (envAuth) {
      authRef = envAuth;
      authFromEnv = true;
    }
  }
  const usingAuth = !!authRef;
  let authState: CookieState | undefined;
  let authResolvedPath: string | undefined;
  if (usingAuth) {
    authResolvedPath = resolveCookieStateRef(authRef!);
    if (authFromEnv) {
      console.error(`auth: using BROWSER_PILOT_AUTH \u2192 ${authResolvedPath}`);
    }
    authState = await loadCookieStateFile(authRef!);
    // Implies --new-tab: a saved cookie snapshot is restored into a fresh
    // tab so it never touches an existing, already-authenticated tab.
    options.newTab = true;
    if (
      options.pageUrl &&
      !authState.cookies.some((c) =>
        domainMatches(hostFromUrl(options.pageUrl!), c.domain, c.hostOnly)
      )
    ) {
      console.error(
        `Warning: --page-url host does not match any cookie domain in the snapshot (${authResolvedPath}).`
      );
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
    // Both direct commands and the cloud daemon handoff reconnect to this session.
    ...(provider === 'browserbase' ? { session: { keepAlive: true } } : {}),
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

  try {
    if (useDaemon) {
      try {
        const created = await createLocalSession({
          wsUrl: wsUrl!,
          trace: globalOptions.trace,
          name: sessionId,
          newTab: options.newTab,
          pageUrl: usingAuth ? undefined : pageUrl,
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
        ? await browser.newPage(usingAuth ? 'about:blank' : (pageUrl ?? 'about:blank'), {
            background: options.foreground !== true,
          })
        : await browser.page(
            undefined,
            options.targetUrl !== undefined ? { targetUrl: options.targetUrl } : undefined
          );
    }
    let currentUrl = await resolveInitialPageUrl(page, usingAuth ? undefined : pageUrl);

    if (browser.metadata?.['liveUrl']) {
      console.error(`\nLive viewer: ${browser.metadata['liveUrl']}\n`);
    }

    // Apply Cloudflare Access sugar (--cf-access) before persisting the session,
    // so the resulting EnvSettings.auth is reapplied on every attach/reattach.
    let cfAccessAuth: EnvSettings['auth'] | undefined;

    // Restore a saved cookie snapshot (--auth) into the fresh, still-unnavigated
    // tab before any navigation happens, so no request ever leaves without the
    // restored cookies attached.
    let cookieAuthMetadata: NonNullable<SessionData['metadata']>['cookieAuth'] | undefined;
    let cookieAuthOutput:
      | {
          file: string;
          sourceUrl: string;
          savedAt: string;
          cookieCount: number;
          restored: number;
          skippedExpired: number;
          unverified: number;
        }
      | undefined;
    if (usingAuth) {
      let restoreResult: Awaited<ReturnType<typeof restoreCookieState>>;
      try {
        restoreResult = await restoreCookieState(page, authState!);
      } catch (error) {
        // Restore failed before any navigation. Close only the resources this
        // command just created; cookie writes are not transactional, so this
        // never claims a rollback of whatever `Storage.setCookies` already did.
        if (daemonSession) {
          await deleteSession(sessionId).catch(() => {});
        }
        await browser.disconnect().catch(() => {});
        throw error;
      }

      if (globalOptions.format !== 'json') {
        console.log(
          `Restored ${restoreResult.restored} cookies (${restoreResult.skippedExpired} expired skipped) from ${authResolvedPath}. Authentication has not been verified.`
        );
        if (restoreResult.unverified > 0) {
          console.log(
            `Warning: ${restoreResult.unverified} of ${restoreResult.restored} restored cookies could not be verified after read-back (domains: ${restoreResult.domains.join(', ')}).`
          );
        }
      }

      const destUrl = pageUrl ?? authState!.sourceUrl;

      if (options.cfAccess) {
        const mode = options.cfAccessMode ?? 'cookie';
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
          // Mint against the resolved destination (pageUrl ?? snapshot sourceUrl),
          // not a page URL sampled mid-flight: the fresh CF cookie must win before
          // the single navigation below.
          const { cookie } = await mintCfAccessJwt({ url: destUrl, clientId, clientSecret });
          await page.setCookie(cookie);
          cfAccessAuth = { cookies: [{ ...cookie }] };
        }
      }

      // Single navigation: the destination was withheld from tab-open above so
      // that restore always precedes the first request.
      await page.goto(destUrl);
      currentUrl = await page.url();

      cookieAuthMetadata = {
        source: shortenHome(authResolvedPath!),
        restoredAt: new Date().toISOString(),
        cookieCount: restoreResult.restored,
      };
      cookieAuthOutput = {
        file: authResolvedPath!,
        sourceUrl: authState!.sourceUrl,
        savedAt: authState!.savedAt,
        cookieCount: restoreResult.restored,
        restored: restoreResult.restored,
        skippedExpired: restoreResult.skippedExpired,
        unverified: restoreResult.unverified,
      };
    }

    if (options.cfAccess && !usingAuth) {
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
        ...(cookieAuthMetadata ? { cookieAuth: cookieAuthMetadata } : {}),
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
        const idleTimeoutMs = options.daemonIdleMins
          ? options.daemonIdleMins * 60 * 1000
          : undefined;

        // The CLI daemon reads its identity once at startup. Persist the
        // cloud session's bootstrap contract before spawning, just as the
        // local CLI connection service does for local sessions.
        const connectionKey = connectionKeyForBrowser({
          provider,
          wsUrl: session.wsUrl,
          userDataDir: session.metadata?.resolvedUserDataDir,
          ...(session.metadata?.connectionSource === 'json-version'
            ? { legacyHost: new URL(session.wsUrl).host }
            : {}),
          providerSessionId: session.providerSessionId,
        });
        const daemonId = daemonIdForConnection(connectionKey);
        await updateSession(sessionId, { transport: { mode: 'daemon', daemonId } });
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
          await writeDaemonDescriptor({
            schemaVersion: 1,
            id: daemonId,
            connectionKey,
            endpointFingerprint: endpointFingerprint(updated.wsUrl),
            pid: updated.daemon.pid,
            socketPath: updated.daemon.socketPath,
            startedAt: updated.daemon.startedAt,
            ...(updated.daemon.heartbeatPath
              ? { heartbeatPath: updated.daemon.heartbeatPath }
              : {}),
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
        // Keep Browserbase's cleanup handle: keepAlive survives a failed daemon handoff.
        if (provider !== 'browserbase') await deleteSession(sessionId).catch(() => {});
        throw new Error(
          `Could not start the session daemon: ${error instanceof Error ? error.message : String(error)}` +
            (provider === 'browserbase'
              ? `; session ${sessionId} retained for retry or bp close.`
              : '')
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
        transport: daemonResult ? 'daemon' : 'direct',
        connectionSource,
        resolvedChannel,
        resolvedUserDataDir,
        provenance: getBuildProvenance(),
        metadata: outputMetadata,
        daemon: daemonResult,
        ...(cookieAuthOutput ? { cookieAuth: cookieAuthOutput } : {}),
      },
      globalOptions.format
    );
  } catch (error) {
    if (provider === 'browserbase' && browser) {
      if (await sessionExists(sessionId).catch(() => false)) {
        await browser.disconnect().catch(() => {});
      } else {
        // Setup failed before the normal record was written. Release the
        // keep-alive session, retaining a cleanup handle if release is pending.
        const release = await browser.close().catch(() => undefined);
        if (!release || release.status === 'cleanup_pending') {
          try {
            await createSession({
              id: sessionId,
              provider,
              wsUrl: browser.wsUrl,
              providerSessionId: browser.sessionId,
              createdAt: new Date().toISOString(),
              lastActivity: new Date().toISOString(),
              currentUrl: 'about:blank',
              transport: { mode: 'direct', reason: 'recovery' },
              metadata: browser.metadata,
            });
          } catch (recordError) {
            console.error(
              `Warning: Browserbase setup failed and the local cleanup record could not be persisted ` +
                `for session ${sessionId} (provider session ${browser.sessionId}). ` +
                `The remote keep-alive session may still be running; clean it up manually via the ` +
                `Browserbase dashboard. Record error: ` +
                `${recordError instanceof Error ? recordError.message : String(recordError)}`
            );
            throw error;
          }
          throw new Error(
            `Browserbase setup failed; cleanup pending for session ${sessionId}. Retry bp close.`,
            { cause: error }
          );
        }
      }
    }
    throw error;
  }
}
