/**
 * Connect command - Create or resume a browser session
 */

import { type BrowserOptions, connect, getBrowserWebSocketUrl } from '../../index.ts';
import { output } from '../index.ts';
import {
  generateSessionId,
  loadSession,
  type ProviderType,
  type SessionData,
  saveSession,
} from '../session.ts';

interface ConnectOptions {
  provider?: ProviderType;
  url?: string;
  name?: string;
  resume?: string;
  apiKey?: string;
  projectId?: string;
}

function parseConnectArgs(args: string[]): ConnectOptions {
  const options: ConnectOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--provider' || arg === '-p') {
      options.provider = args[++i] as ProviderType;
    } else if (arg === '--url') {
      options.url = args[++i];
    } else if (arg === '--name' || arg === '-n') {
      options.name = args[++i];
    } else if (arg === '--resume' || arg === '-r') {
      options.resume = args[++i];
    } else if (arg === '--api-key') {
      options.apiKey = args[++i];
    } else if (arg === '--project-id') {
      options.projectId = args[++i];
    }
  }

  return options;
}

export async function connectCommand(
  args: string[],
  globalOptions: { session?: string; output?: 'json' | 'pretty'; trace?: boolean }
): Promise<void> {
  const options = parseConnectArgs(args);

  // Resume existing session
  if (options.resume || globalOptions.session) {
    const sessionId = options.resume || globalOptions.session!;
    const session = await loadSession(sessionId);

    output(
      {
        success: true,
        resumed: true,
        sessionId: session.id,
        provider: session.provider,
        currentUrl: session.currentUrl,
      },
      globalOptions.output
    );
    return;
  }

  // Determine provider and connection details
  const provider: ProviderType = options.provider ?? 'generic';
  let wsUrl = options.url;

  // Auto-discover WebSocket URL for generic provider
  if (provider === 'generic' && !wsUrl) {
    try {
      wsUrl = await getBrowserWebSocketUrl('localhost:9222');
    } catch {
      throw new Error(
        'Could not auto-discover browser. Specify --url or start Chrome with --remote-debugging-port=9222'
      );
    }
  }

  // Build connection options
  const connectOptions: BrowserOptions = {
    provider,
    debug: globalOptions.trace,
    wsUrl,
    apiKey: options.apiKey,
    projectId: options.projectId,
  };

  // Connect to browser
  const browser = await connect(connectOptions);
  const page = await browser.page();
  const currentUrl = await page.url();

  // Generate session ID
  const sessionId = options.name ?? generateSessionId();

  // Save session
  const session: SessionData = {
    id: sessionId,
    provider,
    wsUrl: browser.wsUrl,
    providerSessionId: browser.sessionId,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    currentUrl,
    metadata: browser.metadata,
  };

  await saveSession(session);

  // Disconnect (session can be resumed)
  await browser.disconnect();

  output(
    {
      success: true,
      sessionId,
      provider,
      currentUrl,
      metadata: browser.metadata,
    },
    globalOptions.output
  );
}
