/**
 * Help text for the `bp` just-bash command.
 */

interface HelpEntry {
  usage: string;
  capability: 'read' | 'evaluate' | 'action' | 'webmcp';
  summary: string;
  detail?: string;
}

const HELP_ENTRIES: Record<string, HelpEntry> = {
  'session open': {
    usage:
      'bp session open [--provider browserbase|browserless|browser-use|generic] [--width N] [--height N]',
    capability: 'read',
    summary: 'Open a provider session via the trusted host; prints an opaque SessionHandle (JSON).',
    detail:
      'The handle contains no credentials. Save it and pass it to other bp commands. ' +
      'Generic sessions require an endpoint configured by the host (InProcessSessionOwner: genericWsUrl). ' +
      'InProcessSessionOwner enables Browserbase keepAlive (paid plan) and rejects Browserless; Browserless requires a custom owner that manages reconnection.',
  },
  'session close': {
    usage: 'bp session close <handle-json> | --handle-file FILE',
    capability: 'read',
    summary: 'Release the provider session; prints the ProviderReleaseResult (JSON).',
  },
  'session touch': {
    usage: 'bp session touch <handle-json> | --handle-file FILE',
    capability: 'read',
    summary: 'Extend the session lease; prints the refreshed SessionHandle (JSON).',
  },
  goto: {
    usage: 'bp goto <handle-json|--handle-file FILE> <url> [--target ID]',
    capability: 'read',
    summary: 'Navigate the active page; prints final url and title.',
  },
  tabs: {
    usage: 'bp tabs <handle-json|--handle-file FILE>',
    capability: 'read',
    summary: 'List page targets (tabs) as JSON.',
  },
  inspect: {
    usage: 'bp inspect <handle-json|--handle-file FILE> [--target ID]',
    capability: 'read',
    summary: 'DOM/accessibility snapshot with ref:eN selectors (JSON).',
  },
  text: {
    usage: 'bp text <handle-json|--handle-file FILE> [selector] [--target ID]',
    capability: 'read',
    summary: 'Extract page or element text. --format text prints raw text.',
  },
  screenshot: {
    usage:
      'bp screenshot <handle-json|--handle-file FILE> --out PATH [--target ID] [--full-page] [--img-format png|jpeg|webp]',
    capability: 'read',
    summary: 'Capture a screenshot to the artifact sink; prints a {status,hash,size,ref} receipt.',
    detail: 'Requires the host to configure an artifact sink. Binary output never goes to stdout.',
  },
  eval: {
    usage: 'bp eval <handle-json|--handle-file FILE> <js-expression> [--target ID]',
    capability: 'evaluate',
    summary: 'Evaluate a JavaScript expression in the page; prints {result}.',
  },
  click: {
    usage: 'bp click <handle-json|--handle-file FILE> <selector> [--target ID]',
    capability: 'action',
    summary: 'Click an element; prints dispatch state, target, and url before/after.',
  },
  type: {
    usage: 'bp type <handle-json|--handle-file FILE> <selector> <text> [--target ID]',
    capability: 'action',
    summary: 'Type text into an element; prints dispatch state, target, and url before/after.',
  },
  press: {
    usage: 'bp press <handle-json|--handle-file FILE> <key> [--target ID]',
    capability: 'action',
    summary: 'Press a key (e.g. Enter); prints dispatch state and url before/after.',
  },
  'webmcp list': {
    usage: 'bp webmcp list <handle-json|--handle-file FILE> [--target ID] [--from-origins a,b]',
    capability: 'webmcp',
    summary: 'List WebMCP tools exposed by the page (JSON).',
  },
  'webmcp call': {
    usage:
      'bp webmcp call <handle-json|--handle-file FILE> <tool> [--target ID] [--input JSON|-] [--origin O] [--confirm-mutation]',
    capability: 'webmcp',
    summary: 'Invoke a WebMCP page tool; prints {tool, result}.',
    detail: 'Tools not marked read-only require --confirm-mutation.',
  },
};

const NATIVE_ONLY =
  'Native-only (use the bp CLI, not this shell): daemon/attach, record, run/actions batches, ' +
  'audio & voice, listen/trace, forms, review, env auth, local Chrome discovery.';

const EXIT_CODES =
  'Exit codes: 0 ok, 1 runtime, 2 usage/stale handle/expired lease, 3 capability denied, ' +
  '124 deadline exceeded, 130 cancelled.';

export function helpText(topic?: string): string {
  if (topic) {
    const entry = HELP_ENTRIES[topic];
    if (!entry) {
      const known = Object.keys(HELP_ENTRIES).join(', ');
      return `Unknown bp command '${topic}'. Known commands: ${known}\n`;
    }
    const lines = [
      entry.usage,
      '',
      `${entry.summary} [capability: ${entry.capability}]`,
      ...(entry.detail ? ['', entry.detail] : []),
      '',
      'Handles: pass the SessionHandle JSON as an argument, or --handle-file FILE',
      "(use '-' to read the handle from stdin).",
      '',
      EXIT_CODES,
    ];
    return `${lines.join('\n')}\n`;
  }

  const lines = [
    'bp — browser-pilot commands for just-bash (JSON output by default)',
    '',
    'Commands (capability required in brackets):',
    ...Object.entries(HELP_ENTRIES).map(
      ([name, entry]) => `  ${name.padEnd(16)} [${entry.capability.padEnd(8)}] ${entry.summary}`
    ),
    '',
    "Use 'bp <command> --help' for details. Global flags: --format json|text, --target ID for page commands.",
    '',
    EXIT_CODES,
    '',
    NATIVE_ONLY,
  ];
  return `${lines.join('\n')}\n`;
}
