/**
 * Text command - Extract text content from page
 */

import { connect } from '../../index.ts';
import { output } from '../index.ts';
import { getDefaultSession, loadSession, type SessionData, updateSession } from '../session.ts';

interface TextOptions {
  selector?: string;
}

function parseTextArgs(args: string[]): TextOptions {
  const options: TextOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--selector' || arg === '-s') {
      options.selector = args[++i];
    }
  }

  return options;
}

export async function textCommand(
  args: string[],
  globalOptions: { session?: string; output?: 'json' | 'pretty'; trace?: boolean }
): Promise<void> {
  const options = parseTextArgs(args);

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
    const page = await browser.page();
    const text = await page.text(options.selector);
    const currentUrl = await page.url();

    // Update session with current URL
    await updateSession(session.id, { currentUrl });

    // Output text
    if (globalOptions.output === 'json') {
      output({ text, url: currentUrl, selector: options.selector }, 'json');
    } else {
      console.log(text);
    }
  } finally {
    await browser.disconnect();
  }
}
