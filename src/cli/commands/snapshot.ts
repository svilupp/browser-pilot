/**
 * Snapshot command - Get page accessibility snapshot
 */

import { connect } from '../../index.ts';
import { output } from '../index.ts';
import { getDefaultSession, loadSession, type SessionData, updateSession } from '../session.ts';

interface SnapshotOptions {
  format?: 'full' | 'interactive' | 'text';
}

function parseSnapshotArgs(args: string[]): SnapshotOptions {
  const options: SnapshotOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--format' || arg === '-f') {
      options.format = args[++i] as SnapshotOptions['format'];
    }
  }

  return options;
}

export async function snapshotCommand(
  args: string[],
  globalOptions: { session?: string; output?: 'json' | 'pretty'; trace?: boolean }
): Promise<void> {
  const options = parseSnapshotArgs(args);

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
    const snapshot = await page.snapshot();

    // Update session with current URL
    await updateSession(session.id, { currentUrl: snapshot.url });

    // Output based on format
    switch (options.format) {
      case 'interactive':
        output(snapshot.interactiveElements, globalOptions.output);
        break;

      case 'text':
        // For text format, output the text representation directly
        console.log(snapshot.text);
        break;
      default:
        output(snapshot, globalOptions.output);
        break;
    }
  } finally {
    await browser.disconnect();
  }
}
