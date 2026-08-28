import {
  BrowserEndpointResolutionError,
  type ChromeChannel,
  type ResolvedBrowserEndpoint,
  resolveBrowserEndpoint,
} from '../providers/index.ts';

export interface ResolveCLIEndpointOptions {
  explicitWsUrl?: string;
  channel?: ChromeChannel;
  userDataDir?: string;
}

export interface FormatBrowserDiscoveryErrorOptions {
  explicitFlag?: '--browser-url' | '--url';
  explicitHint?: string;
  reuseSessionHint?: string;
  latestSessionHint?: string;
}

export async function resolveCLIEndpoint(
  options: ResolveCLIEndpointOptions = {}
): Promise<ResolvedBrowserEndpoint> {
  return resolveBrowserEndpoint({
    explicitWsUrl: options.explicitWsUrl,
    channel: options.channel,
    userDataDir: options.userDataDir,
    // Endpoint discovery must not open a speculative browser WebSocket. The
    // daemon (or the explicit direct connection in --no-daemon mode) owns the
    // first protocol connection, avoiding repeated Chrome permission prompts.
    probe: 'none',
    allowLocalDiscovery: true,
    allowLegacyHostFallback: true,
  });
}

function formatCandidateLabel(candidate: {
  channel?: ChromeChannel | 'custom';
  userDataDir: string;
}): string {
  const channelLabel = candidate.channel ? `${candidate.channel}` : 'unknown';
  return `${channelLabel}: ${candidate.userDataDir}`;
}

export function formatBrowserDiscoveryError(
  error: unknown,
  options: FormatBrowserDiscoveryErrorOptions = {}
): string {
  const explicitFlag = options.explicitFlag ?? '--browser-url';

  if (error instanceof BrowserEndpointResolutionError) {
    if (error.code === 'multiple-local-browsers') {
      const candidates = error.details.candidates ?? [];
      const foundLines =
        candidates.length > 0
          ? candidates.map((candidate) => `  - ${formatCandidateLabel(candidate)}`).join('\n')
          : '  - Multiple local Chrome profiles were found';

      return (
        'Multiple running Chrome profiles have remote debugging enabled.\n' +
        `${foundLines}\n` +
        'Pass --channel <stable|beta|dev|canary> or --user-data-dir <path>.'
      );
    }

    const lines = [
      'Could not auto-discover browser.',
      'Recommended for Chrome 144+:',
      '  1. Open Chrome and enable remote debugging in chrome://inspect/#remote-debugging',
      '  2. Keep Chrome running, then retry',
      'Other options:',
      options.explicitHint ?? `  - Pass ${explicitFlag} with a browser WebSocket URL`,
      '  - Launch Chrome with --remote-debugging-port=9222 and a custom --user-data-dir',
    ];

    if (options.reuseSessionHint) {
      lines.push(`  - Reuse an existing session: ${options.reuseSessionHint}`);
    }

    if (options.latestSessionHint) {
      lines.push(`  - Use latest session: ${options.latestSessionHint}`);
    }

    return lines.join('\n');
  }

  return error instanceof Error ? error.message : String(error);
}
