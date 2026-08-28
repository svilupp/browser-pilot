/** First-class WebMCP discovery and invocation commands. */

import { webmcpCall, webmcpList, webmcpStatus } from '../../webmcp/client.ts';
import { attachSession, resolveSession } from '../attach.ts';
import { output } from '../output.ts';

const WEBMCP_HELP = `
bp webmcp - Discover and invoke tools exposed by the current page

Usage:
  bp webmcp status [options]
  bp webmcp list [options]
  bp webmcp call <tool-name> --input '<json>' [--confirm-mutation] [options]

Options:
  --input <json>        JSON input passed to a tool
  --origin <origin>     Restrict a tool lookup to an exact origin
  --from-origin <origin> Include cross-origin tools explicitly (repeatable)
  --confirm-mutation    Acknowledge invocation of tools not marked read-only
  --timeout <ms>        Invocation timeout (default: 30000)
  -s, --session <id>     Session to use (default: most recent)
  --json                 Output JSON
  --pretty               Output readable text (default)
`.trimEnd();

interface WebMCPOptions {
  subcommand?: 'status' | 'list' | 'call';
  name?: string;
  input?: string;
  origin?: string;
  fromOrigins: string[];
  confirmMutation?: boolean;
  timeoutMs?: number;
}

function parseWebMCPArgs(args: string[]): WebMCPOptions {
  const options: WebMCPOptions = { fromOrigins: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === 'status' || arg === 'list' || arg === 'call') {
      options.subcommand = arg;
    } else if (arg === '--input') {
      options.input = args[++i];
    } else if (arg === '--origin') {
      options.origin = args[++i];
    } else if (arg === '--from-origin') {
      const origin = args[++i];
      if (origin) options.fromOrigins.push(origin);
    } else if (arg === '--confirm-mutation') {
      options.confirmMutation = true;
    } else if (arg === '--timeout') {
      const timeout = Number.parseInt(args[++i] ?? '', 10);
      if (!Number.isFinite(timeout) || timeout < 1) throw new Error('--timeout must be positive');
      options.timeoutMs = timeout;
    } else if (!arg.startsWith('-') && options.subcommand === 'call' && !options.name) {
      options.name = arg;
    }
  }
  return options;
}

export async function webmcpCommand(
  args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  if (globalOptions.help) {
    console.log(WEBMCP_HELP);
    return;
  }

  const options = parseWebMCPArgs(args);
  if (!options.subcommand) {
    console.log(WEBMCP_HELP);
    return;
  }

  const session = await resolveSession(globalOptions.session);
  const { browser, page } = await attachSession(session, { trace: globalOptions.trace });
  try {
    if (options.subcommand === 'status') {
      output(await webmcpStatus(page), globalOptions.format);
      return;
    }

    if (options.subcommand === 'list') {
      output(await webmcpList(page, options.fromOrigins), globalOptions.format);
      return;
    }

    if (!options.name) throw new Error('webmcp call requires a tool name');
    if (!options.input) throw new Error('webmcp call requires --input <json>');
    let input: unknown;
    try {
      input = JSON.parse(options.input);
    } catch (error) {
      throw new Error(
        `Invalid --input JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const result = await webmcpCall(page, options.name, input, {
      origin: options.origin,
      fromOrigins: options.fromOrigins,
      allowMutation: options.confirmMutation,
      timeoutMs: options.timeoutMs,
    });
    output(result, globalOptions.format);
  } finally {
    await browser.disconnect();
  }
}
