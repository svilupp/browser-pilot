/**
 * Text command - Extract text content from page
 */

import { attachSession } from '../attach.ts';
import { output } from '../output.ts';
import { getDefaultSession, loadSession, type SessionData, updateSession } from '../session.ts';

const TEXT_HELP = `
bp text - Extract text content from the current page

When to use:
  You need readable content for summarization, comparison, or assertions outside the action batch.

When not to use:
  You are choosing clickable or fillable targets. Use \`bp snapshot -i\` or \`bp page\`.

Common mistake:
  Expecting \`bp text\` to tell you what to click next. It is content-focused, not action-focused.

Usage:
  bp text [options]

Local options:
  --selector <selector>  Extract text from a specific element (default: entire page)

Global options:
  -s, --session <id>     Session to use (default: most recent)
  --json                 Output JSON with text, URL, and selector
  --pretty               Output readable text only (default)
  --debug                Enable CDP transport debugging
  -h, --help             Show this help

Examples:
  bp text                          # Extract all text from the page
  bp text --selector '#main'       # Extract text from #main element only
  bp text -s dev --json            # Output JSON with URL and selector info

Likely next commands:
  bp snapshot -i
  bp review --json
  bp exec '[{"action":"assertText","expect":"..."}]'
`.trimEnd();

interface TextOptions {
  selector?: string;
  help?: boolean;
}

function parseTextArgs(args: string[]): TextOptions {
  const options: TextOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--selector') {
      options.selector = args[++i];
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    }
  }

  return options;
}

function looksLikeSelector(value: string): boolean {
  return (
    value.startsWith('#') ||
    value.startsWith('.') ||
    value.startsWith('[') ||
    value.startsWith('/') ||
    value.startsWith('ref:') ||
    value.includes('>')
  );
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
    try {
      session = await loadSession(globalOptions.session);
    } catch (error) {
      if (!options.selector && looksLikeSelector(globalOptions.session)) {
        throw new Error(
          `bp text uses --selector for element targeting. "-s" is reserved for sessions.\n\nTry: bp text --selector ${JSON.stringify(globalOptions.session)}`
        );
      }
      throw error;
    }
  } else {
    session = await getDefaultSession();
    if (!session) {
      throw new Error('No session found. Run "bp connect" first.');
    }
  }

  // Connect to browser
  const { browser, page } = await attachSession(session, { trace: globalOptions.trace });

  try {
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
