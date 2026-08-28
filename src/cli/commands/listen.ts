/**
 * Listen command - Monitor network traffic (WebSocket/HTTP) via CDP
 *
 * Outputs structured JSONL to stdout, status messages to stderr.
 * Binary WebSocket payloads replaced with size placeholders.
 */

import type { CDPClient } from '../../cdp/client.ts';
import { attachSession } from '../attach.ts';
import { formatBrowserDiscoveryError, resolveCLIEndpoint } from '../browser-endpoint.ts';
import { createLocalSession } from '../connect-service.ts';
import { getDefaultSession, loadSession } from '../session.ts';

const LISTEN_HELP = `
bp listen - Monitor network traffic (WebSocket/HTTP)

Attach to a browser session and stream network events as JSONL.
Status messages go to stderr; stdout is clean JSONL (pipeable to jq).

Usage:
  bp listen <mode> [options]

Modes:
  ws      WebSocket traffic only
  http    HTTP requests/responses only
  all     Both WebSocket and HTTP

Options:
  -s, --session [id]     Session to use (omit: auto-connect, -s: latest, -s <id>: specific)
  -m, --match <glob>     Filter by URL glob pattern (e.g. "*realtime*")
  -o, --output <file>    Write JSONL to file instead of stdout
  --max-payload <n>      Max text payload preview length (default: 256)
  --timeout <ms>         Auto-stop after N milliseconds
  -q, --quiet            Suppress stderr status messages
  -h, --help             Show this help

Output Format (JSONL):
  {"ts":"...","type":"ws:created","requestId":"1.2","url":"wss://..."}
  {"ts":"...","type":"ws:frame:sent","requestId":"1.2","opcode":1,"length":142,"payload":"..."}
  {"ts":"...","type":"ws:frame:recv","requestId":"1.2","opcode":2,"length":24000,"payload":"[binary: 18000 bytes]"}
  {"ts":"...","type":"ws:closed","requestId":"1.2"}
  {"ts":"...","type":"http:request","requestId":"3.1","method":"POST","url":"https://..."}
  {"ts":"...","type":"http:response","requestId":"3.1","status":200,"mimeType":"application/json"}

Examples:
  # Debug a voice agent's WebSocket protocol
  bp listen ws -m "*voice*" -o voice-traffic.jsonl

  # Watch all API calls during a session
  bp listen http -m "*/api/*" --max-payload 1024

  # Capture everything for 60 seconds
  bp listen all -o full-trace.jsonl --timeout 60000

  # Pipe to jq for live filtering
  bp listen ws | jq 'select(.type == "ws:frame:recv")'
`;

export type ListenMode = 'ws' | 'http' | 'all';

export interface ListenOptions {
  mode?: ListenMode;
  match?: string;
  output?: string;
  maxPayload?: number;
  timeout?: number;
  quiet?: boolean;
  help?: boolean;
  useLatestSession?: boolean;
}

export function parseListenArgs(args: string[]): ListenOptions {
  const options: ListenOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '-m' || arg === '--match') {
      options.match = args[++i];
    } else if (arg === '-o' || arg === '--output') {
      options.output = args[++i];
    } else if (arg === '--max-payload') {
      options.maxPayload = Number.parseInt(args[++i] ?? '', 10);
    } else if (arg === '--timeout') {
      options.timeout = Number.parseInt(args[++i] ?? '', 10);
    } else if (arg === '-q' || arg === '--quiet') {
      options.quiet = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-s' || arg === '--session') {
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('-')) {
        options.useLatestSession = true;
      }
    } else if (!arg.startsWith('-') && !options.mode) {
      if (arg === 'ws' || arg === 'http' || arg === 'all') {
        options.mode = arg;
      }
    }
  }

  return options;
}

import { globToRegex } from '../../utils/strings.ts';
export { globToRegex };

type EventHandler = (params: Record<string, unknown>) => void;

export interface TrafficMonitorOptions {
  mode: ListenMode;
  match?: string;
  maxPayload: number;
  write: (line: string) => void;
}

export class TrafficMonitor {
  private cdp: CDPClient;
  private opts: TrafficMonitorOptions;
  private matchRegex: RegExp | null;
  private wsUrls = new Map<string, string>();
  private httpUrls = new Map<string, string>();
  private handlers: Array<{ event: string; handler: EventHandler }> = [];
  lineCount = 0;

  constructor(cdp: CDPClient, opts: TrafficMonitorOptions) {
    this.cdp = cdp;
    this.opts = opts;
    this.matchRegex = opts.match ? globToRegex(opts.match) : null;
  }

  private emit(record: Record<string, unknown>): void {
    this.opts.write(JSON.stringify(record));
    this.lineCount++;
  }

  private matchesUrl(url: string): boolean {
    if (!this.matchRegex) return true;
    return this.matchRegex.test(url);
  }

  private formatPayload(
    payloadData: string | undefined,
    opcode: number
  ): { payload: string; length: number } {
    const data = payloadData ?? '';

    if (opcode === 2) {
      // Binary frame — base64 encoded, estimate original size
      const byteLength = Math.floor((data.length * 3) / 4);
      return { payload: `[binary: ${byteLength} bytes]`, length: data.length };
    }

    const length = data.length;
    if (length > this.opts.maxPayload) {
      return {
        payload: `${data.slice(0, this.opts.maxPayload)}... [truncated, ${length} total]`,
        length,
      };
    }

    return { payload: data, length };
  }

  private subscribe(event: string, handler: EventHandler): void {
    this.cdp.on(event, handler);
    this.handlers.push({ event, handler });
  }

  start(): void {
    const mode = this.opts.mode;

    if (mode === 'ws' || mode === 'all') {
      this.subscribe('Network.webSocketCreated', (params) => {
        const url = params['url'] as string;
        const requestId = params['requestId'] as string;

        if (!this.matchesUrl(url)) return;

        this.wsUrls.set(requestId, url);
        this.emit({
          ts: new Date().toISOString(),
          type: 'ws:created',
          requestId,
          url,
        });
      });

      this.subscribe('Network.webSocketFrameSent', (params) => {
        const requestId = params['requestId'] as string;
        if (!this.wsUrls.has(requestId)) return;

        const response = params['response'] as { opcode: number; payloadData?: string } | undefined;
        const opcode = response?.opcode ?? 1;
        const { payload, length } = this.formatPayload(response?.payloadData, opcode);

        this.emit({
          ts: new Date().toISOString(),
          type: 'ws:frame:sent',
          requestId,
          opcode,
          length,
          payload,
        });
      });

      this.subscribe('Network.webSocketFrameReceived', (params) => {
        const requestId = params['requestId'] as string;
        if (!this.wsUrls.has(requestId)) return;

        const response = params['response'] as { opcode: number; payloadData?: string } | undefined;
        const opcode = response?.opcode ?? 1;
        const { payload, length } = this.formatPayload(response?.payloadData, opcode);

        this.emit({
          ts: new Date().toISOString(),
          type: 'ws:frame:recv',
          requestId,
          opcode,
          length,
          payload,
        });
      });

      this.subscribe('Network.webSocketClosed', (params) => {
        const requestId = params['requestId'] as string;
        if (!this.wsUrls.has(requestId)) return;

        this.wsUrls.delete(requestId);
        this.emit({
          ts: new Date().toISOString(),
          type: 'ws:closed',
          requestId,
        });
      });
    }

    if (mode === 'http' || mode === 'all') {
      this.subscribe('Network.requestWillBeSent', (params) => {
        const request = params['request'] as { url: string; method: string } | undefined;
        const url = request?.url ?? '';
        const requestId = params['requestId'] as string;

        if (!this.matchesUrl(url)) return;

        this.httpUrls.set(requestId, url);
        this.emit({
          ts: params['wallTime']
            ? new Date((params['wallTime'] as number) * 1000).toISOString()
            : new Date().toISOString(),
          type: 'http:request',
          requestId,
          method: request?.method ?? 'GET',
          url,
        });
      });

      this.subscribe('Network.responseReceived', (params) => {
        const requestId = params['requestId'] as string;
        if (!this.httpUrls.has(requestId)) return;

        const response = params['response'] as
          | {
              status: number;
              mimeType: string;
            }
          | undefined;

        this.emit({
          ts: new Date().toISOString(),
          type: 'http:response',
          requestId,
          status: response?.status ?? 0,
          mimeType: response?.mimeType ?? '',
        });
      });

      this.subscribe('Network.loadingFailed', (params) => {
        const requestId = params['requestId'] as string;
        if (!this.httpUrls.has(requestId)) return;

        this.emit({
          ts: new Date().toISOString(),
          type: 'http:failed',
          requestId,
          errorText: (params['errorText'] as string) ?? '',
        });
      });
    }
  }

  stop(): void {
    for (const { event, handler } of this.handlers) {
      this.cdp.off(event, handler);
    }
    this.handlers = [];
  }
}

async function resolveConnection(
  sessionId: string | undefined,
  useLatestSession: boolean,
  trace: boolean
) {
  if (sessionId) {
    const session = await loadSession(sessionId);
    const { browser } = await attachSession(session, { trace });
    return { browser, session };
  }

  if (useLatestSession) {
    const session = await getDefaultSession();
    if (!session) {
      throw new Error('No sessions found. Run "bp connect" first or omit -s to auto-connect.');
    }
    const { browser } = await attachSession(session, { trace });
    return { browser, session };
  }

  // Auto-connect to local browser
  let endpoint: Awaited<ReturnType<typeof resolveCLIEndpoint>>;
  try {
    endpoint = await resolveCLIEndpoint();
  } catch (error) {
    throw new Error(
      formatBrowserDiscoveryError(error, {
        explicitHint: '  - Create a session first: bp connect --browser-url <ws-url>',
        reuseSessionHint: 'bp listen -s <session-id>',
        latestSessionHint: 'bp listen -s',
      })
    );
  }

  const { browser, session } = await createLocalSession({
    wsUrl: endpoint.wsUrl,
    trace,
    connectionSource: endpoint.source,
    resolvedChannel: endpoint.channel,
    resolvedUserDataDir: endpoint.userDataDir,
  });
  return { browser, session };
}

export async function listenCommand(
  args: string[],
  globalOptions: {
    session?: string;
    format?: 'json' | 'pretty';
    trace?: boolean;
    help?: boolean;
  }
): Promise<void> {
  const options = parseListenArgs(args);

  if (options.help || globalOptions.help || !options.mode) {
    console.log(LISTEN_HELP);
    return;
  }

  const log = options.quiet ? () => {} : (msg: string) => process.stderr.write(`${msg}\n`);

  const { browser, session } = await resolveConnection(
    globalOptions.session,
    options.useLatestSession ?? false,
    globalOptions.trace ?? false
  );

  let outputStream: { write: (line: string) => void; close?: () => void };

  if (options.output) {
    const fs = await import('node:fs');
    const fileStream = fs.createWriteStream(options.output, { flags: 'w' });
    outputStream = {
      write: (line: string) => fileStream.write(`${line}\n`),
      close: () => fileStream.end(),
    };
    log(`Writing to ${options.output}`);
  } else {
    outputStream = {
      write: (line: string) => {
        try {
          process.stdout.write(`${line}\n`);
        } catch {
          // EPIPE — consumer closed the pipe
          process.exit(0);
        }
      },
    };

    // Handle EPIPE gracefully
    process.stdout.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
        process.exit(0);
      }
    });
  }

  try {
    const page = await browser.page(undefined, { targetId: session.targetId });
    const cdp = page.cdpClient;

    // Ensure Network domain is enabled
    await cdp.send('Network.enable');

    const monitor = new TrafficMonitor(cdp, {
      mode: options.mode,
      match: options.match,
      maxPayload: options.maxPayload ?? 256,
      write: (line) => outputStream.write(line),
    });

    monitor.start();

    const matchLabel = options.match ? ` matching "${options.match}"` : '';
    log(`Listening for ${options.mode} traffic${matchLabel} (session: ${session.id})`);
    log('Press Ctrl+C to stop.');

    // Set up clean shutdown
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      monitor.stop();
      log(`\nStopped. ${monitor.lineCount} events captured.`);
      outputStream.close?.();
      void browser
        .disconnect()
        .catch(() => {})
        .then(() => process.exit(0));
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    if (options.timeout && options.timeout > 0) {
      setTimeout(() => {
        log(`\nTimeout reached (${options.timeout}ms).`);
        cleanup();
      }, options.timeout);
    }

    // Keep alive until signal
    await new Promise(() => {});
  } catch (error) {
    outputStream.close?.();
    await browser.disconnect();
    throw error;
  }
}
