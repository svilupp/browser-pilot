/**
 * Text command - Extract text content from page
 */

import { connect } from '../../index.ts';
import { output } from '../index.ts';
import { getDefaultSession, loadSession, type SessionData, updateSession } from '../session.ts';

const TEXT_HELP = `
bp text - Extract text content from the current page

Usage:
  bp text [options]

Options:
  --selector <sel>     Extract text from a specific element (default: entire page)
  -s, --session <id>   Session to use (default: most recent)
  -f, --format <fmt>   Output format: json | pretty (default: pretty)
  --json               Alias for -f json
  --trace              Enable debug tracing
  -h, --help           Show this help

Examples:
  bp text                          # Extract all text from the page
  bp text --selector '#main'       # Extract text from #main element only
  bp text --json                   # Output as JSON with URL and selector info
`.trimEnd();

interface TextOptions {
  selector?: string;
  help?: boolean;
}

function parseTextArgs(args: string[]): TextOptions {
  const options: TextOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--selector' || arg === '-s') {
      options.selector = args[++i];
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    }
  }

  return options;
}

export async function textCommand(
  args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  const options = parseTextArgs(args);

  if (options.help || globalOptions.help) {
    console.log(TEXT_HELP);
    return;
  }

  // Get session
  let session: SessionData | null;
  if (globalOptions.session) {
    session = await loadSession(globalOptions.session);
  } else {
    session = await getDefaultSession();
    if (!session) {
      throw new Error('No session found. Run "bp connect" first.');
    }
  }

  // Connect to browser
  const browser = await connect({
    provider: session.provider,
    wsUrl: session.wsUrl,
    debug: globalOptions.trace,
  });

  try {
    const page = await browser.page(undefined, { targetId: session.targetId });
    const text = await page.text(options.selector);
    const currentUrl = await page.url();

    // Update session with current URL
    await updateSession(session.id, { currentUrl });

    // Output text
    if (globalOptions.format === 'json') {
      output({ text, url: currentUrl, selector: options.selector }, 'json');
    } else {
      console.log(text);
    }
  } finally {
    await browser.disconnect();
  }
}
