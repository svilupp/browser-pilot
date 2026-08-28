/**
 * Emit command - inject a message into the page's own message flow.
 *
 * The write-side counterpart to `bp listen`: the frame goes out on a socket the
 * page already opened, carrying its real headers, cookies, and session token.
 */

import { attachSession, resolveSession } from '../attach.ts';
import { output } from '../output.ts';

const EMIT_HELP = `
bp emit - Send a WebSocket frame on the page's own connection

When to use:
  You need to drive a realtime app at the protocol level: send a frame the UI
  cannot produce, exercise a server turn without the UI, or prove that a
  specific message gets a specific reply.

When not to use:
  The UI can produce the message. Use \`bp exec\` and let the app serialize it -
  that also tests the app's own encoding.

Usage:
  bp emit ws <payload> [options]
  bp emit ws --list

Channels:
  ws      Send a frame on a live WebSocket

Local options:
  --list                   List candidate sockets and send nothing (dry run)
  -m, --match <glob>       Select the socket by URL (required if several are open)
  -f, --file <path>        Read the payload from a file
  --base64                 Payload is base64; send a binary frame
  --await <key=value>      Wait for a reply frame with this field (repeatable)
  --await-match <glob>     Wait for a reply frame matching this payload glob
  --await-timeout <ms>     How long to wait for the reply (default: 10000)

Global options:
  -s, --session <id>       Session to use (default: most recent)
  --json                   Output JSON
  --pretty                 Output readable text (default)
  -h, --help               Show this help

Notes:
  A WebSocket send on a closed socket does not throw - the browser discards the
  data silently - so delivery is confirmed against the frame actually appearing
  on the wire. "delivered: false" means the frame was dispatched but never
  observed leaving.

  Emits are never retried automatically. If the page has more than one open
  socket, the command fails with the candidate list instead of guessing.

  Learn the protocol before you inject: capture one real client-to-server frame
  with \`bp trace\`/\`bp listen\` first. A message type that looks right can be a
  server-to-client echo - some apps silently ignore an injected "user.transcript"
  because the client never sends that type, it only receives it.

  Avoid "--await-match '*'" on chatty sockets; heartbeat frames match it too.
  Prefer "--await" on a specific field, or a narrow "--await-match" glob.

Examples:
  bp emit ws --list -s mysession
  bp emit ws '{"type":"client.response.text","content":"show me black shirts"}' \\
    --match 'wss://wire-worker-uat*' \\
    --await-match '*search_results_surfaced*' --await-timeout 30000 -s mysession
  bp emit ws -f turn.json --match "*realtime*"
  bp emit ws '{"type":"ping"}' --await 'type=pong' --await-timeout 5000
  echo '{"type":"ping"}' | bp emit ws
`.trimEnd();

interface EmitOptions {
  channel?: string;
  payload?: string;
  list?: boolean;
  match?: string;
  file?: string;
  base64?: boolean;
  awaitWhere?: Record<string, unknown>;
  awaitMatch?: string;
  awaitTimeout?: number;
}

/** Parse `key=value` into a typed field matcher (numbers and booleans coerced). */
export function parseAwaitExpression(expression: string): [string, unknown] {
  const index = expression.indexOf('=');
  if (index === -1) {
    throw new Error(`Invalid --await expression: "${expression}". Expected key=value.`);
  }
  const key = expression.slice(0, index).trim();
  const raw = expression.slice(index + 1).trim();
  if (raw === 'true') return [key, true];
  if (raw === 'false') return [key, false];
  if (raw !== '' && !Number.isNaN(Number(raw))) return [key, Number(raw)];
  return [key, raw];
}

export function parseEmitArgs(args: string[]): EmitOptions {
  const options: EmitOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--list') {
      options.list = true;
    } else if (arg === '-m' || arg === '--match') {
      options.match = args[++i];
    } else if (arg === '-f' || arg === '--file') {
      options.file = args[++i];
    } else if (arg === '--base64') {
      options.base64 = true;
    } else if (arg === '--await') {
      const [key, value] = parseAwaitExpression(args[++i] ?? '');
      options.awaitWhere = { ...options.awaitWhere, [key]: value };
    } else if (arg === '--await-match') {
      options.awaitMatch = args[++i];
    } else if (arg === '--await-timeout') {
      options.awaitTimeout = Number.parseInt(args[++i] ?? '', 10);
    } else if (!arg.startsWith('-')) {
      if (!options.channel) {
        options.channel = arg;
      } else if (!options.payload) {
        options.payload = arg;
      }
    }
  }

  return options;
}

async function readPayload(options: EmitOptions): Promise<string> {
  if (options.file) {
    return (await Bun.file(options.file).text()).trim();
  }
  if (options.payload) {
    return options.payload;
  }
  if (!process.stdin.isTTY) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
    const stdin = Buffer.concat(chunks).toString('utf8').trim();
    if (stdin) return stdin;
  }
  throw new Error('No payload. Pass it as an argument, with -f <file>, or on stdin.');
}

export async function emitCommand(
  args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  if (globalOptions.help) {
    process.stdout.write(`${EMIT_HELP}\n`);
    return;
  }

  const options = parseEmitArgs(args);

  if (!options.channel) {
    throw new Error('Missing channel. Usage: bp emit ws <payload>');
  }
  if (options.channel !== 'ws') {
    throw new Error(`Unknown channel "${options.channel}". Supported channels: ws`);
  }

  const session = await resolveSession(globalOptions.session);
  const { browser, page } = await attachSession(session, { trace: globalOptions.trace });

  try {
    if (options.list) {
      const candidates = await page.listMessageTargets();
      output(
        globalOptions.format === 'json'
          ? { candidates }
          : candidates.length === 0
            ? 'No WebSocket connections on this page.'
            : candidates
                .map(
                  (c) =>
                    `${READY_STATE[c.readyState] ?? c.readyState}  ${c.url}  [${c.realmLabel ?? c.realm}]`
                )
                .join('\n'),
        globalOptions.format
      );
      return;
    }

    const payload = await readPayload(options);
    const result = await page.emitMessage(payload, {
      ...(options.match ? { match: options.match } : {}),
      ...(options.base64 ? { base64: true } : {}),
      ...(options.awaitWhere || options.awaitMatch
        ? {
            awaitReply: {
              ...(options.awaitWhere ? { where: options.awaitWhere } : {}),
              ...(options.awaitMatch ? { match: options.awaitMatch } : {}),
              ...(options.awaitTimeout ? { timeout: options.awaitTimeout } : {}),
            },
          }
        : {}),
    });

    if (globalOptions.format === 'json') {
      output(result, globalOptions.format);
    } else {
      const lines = [
        `${result.delivered ? 'delivered' : 'dispatched (unconfirmed)'}: ${result.socketUrl}`,
        `realm: ${result.realm}`,
      ];
      if (result.reply) {
        lines.push(`reply (${result.reply.latencyMs}ms): ${result.reply.payload}`);
      } else if (options.awaitWhere || options.awaitMatch) {
        lines.push('reply: none within timeout');
      }
      output(lines.join('\n'), globalOptions.format);
    }

    // A missing reply is a failed expectation, not a successful command.
    if ((options.awaitWhere || options.awaitMatch) && !result.reply) {
      process.exitCode = 1;
    }
  } finally {
    await browser.disconnect();
  }
}

const READY_STATE: Record<number, string> = {
  0: 'CONNECTING',
  1: 'OPEN     ',
  2: 'CLOSING  ',
  3: 'CLOSED   ',
};
