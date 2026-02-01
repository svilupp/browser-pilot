/**
 * Snapshot command - Get page accessibility snapshot
 */

import * as fs from 'node:fs';
import { injectRefOverlay, removeRefOverlay } from '../../browser/overlay.ts';
import { diffSnapshots, formatDiffPretty } from '../../browser/snapshot-diff.ts';
import type { PageSnapshot } from '../../browser/types.ts';
import { connect } from '../../index.ts';
import { output } from '../index.ts';
import { getDefaultSession, loadSession, type SessionData, updateSession } from '../session.ts';

interface SnapshotOptions {
  format?: 'full' | 'interactive' | 'text';
  diffFile?: string;
  inspect?: boolean;
  keep?: boolean;
}

function parseSnapshotArgs(args: string[]): SnapshotOptions {
  const options: SnapshotOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--format' || arg === '-f') {
      options.format = args[++i] as SnapshotOptions['format'];
    } else if (arg === '--diff' || arg === '-d') {
      options.diffFile = args[++i];
    } else if (arg === '--inspect') {
      options.inspect = true;
    } else if (arg === '--keep') {
      options.keep = true;
    }
  }

  return options;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const page = await browser.page(undefined, { targetId: session.targetId });
    const snapshot = await page.snapshot();

    // Update session with current URL
    await updateSession(session.id, {
      currentUrl: snapshot.url,
      metadata: {
        refCache: {
          url: snapshot.url,
          savedAt: new Date().toISOString(),
          refMap: page.exportRefMap(),
        },
      },
    });

    // Handle diff mode
    if (options.diffFile) {
      if (!fs.existsSync(options.diffFile)) {
        throw new Error(`Diff file not found: ${options.diffFile}`);
      }

      const beforeContent = fs.readFileSync(options.diffFile, 'utf-8');
      const beforeSnapshot: PageSnapshot = JSON.parse(beforeContent);
      const diff = diffSnapshots(beforeSnapshot, snapshot);

      if (globalOptions.output === 'json') {
        output(diff, 'json');
      } else {
        console.log(formatDiffPretty(diff));
      }
      return;
    }

    // Handle inspect mode
    if (options.inspect) {
      await injectRefOverlay(page, snapshot);
      console.log('Overlay injected. Element refs are now visible on the page.');

      if (options.keep) {
        console.log(
          'Overlay will remain visible. Use removeRefOverlay() or refresh the page to remove.'
        );
      } else {
        console.log('Overlay will be removed in 10 seconds...');
        await sleep(10000);
        await removeRefOverlay(page);
        console.log('Overlay removed.');
      }
    }

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
