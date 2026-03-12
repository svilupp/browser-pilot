/**
 * Snapshot command - Get page accessibility snapshot
 */

import * as fs from 'node:fs';
import { injectRefOverlay, removeRefOverlay } from '../../browser/overlay.ts';
import { diffSnapshots, formatDiffPretty } from '../../browser/snapshot-diff.ts';
import type { PageSnapshot } from '../../browser/types.ts';
import { connect } from '../../index.ts';
import { isRecord } from '../../utils/json.ts';
import { output, renderOutput } from '../index.ts';
import { getDefaultSession, loadSession, type SessionData, updateSession } from '../session.ts';

const SNAPSHOT_HELP = `
bp snapshot - Inspect the page and collect refs

When to use:
  You need to understand the current page or choose reliable targets for \`bp exec\`.

When not to use:
  You need long-running behavior, network, or voice causality. Use \`bp trace\`.

Default flow:
  snapshot -i -> use ref:eN selectors in exec -> take a fresh snapshot after navigation

Common mistake:
  Reusing refs after the page navigated or materially changed.

Usage:
  bp snapshot [options]

Options:
  -i, --interactive      Show only interactive elements (buttons, inputs, links)
  -f, --format <type>    Output format: full | interactive | text (default: text)
  --role <roles>         Filter snapshot to accessibility roles (for example: radio,checkbox)
  -o, --output <path>    Write command output to a file instead of stdout
  -d, --diff <file>      Compare current page against a saved snapshot JSON
  --inspect              Inject visual ref labels onto the page (auto-removes after 10s)
  --keep                 Keep visual ref labels visible (use with --inspect)
  -s, --session <id>     Session to use (default: most recent)
  -f, --format <fmt>     Output format: json | pretty (default: pretty)
  --json                 Alias for -f json
  --debug                Enable CDP transport debugging (global option)
  -h, --help             Show this help

Examples:
  bp snapshot                       # Full accessibility tree as readable text
  bp snapshot -i                    # Interactive elements only; best default for automation
  bp snapshot --role radio,checkbox # Focus on specific control roles
  bp snapshot --json > page.json    # Save full snapshot to file
  bp snapshot --diff before.json    # Show what changed since before.json
  bp snapshot --inspect             # Visual ref labels on the page

Likely next commands:
  bp exec '[{"action":"click","selector":"ref:e4"}]'
  bp page
  bp diagnose "ref:e4"
`.trimEnd();

interface SnapshotOptions {
  format: 'full' | 'interactive' | 'text';
  formatExplicit?: boolean;
  diffFile?: string;
  outputFile?: string;
  roles?: string[];
  inspect?: boolean;
  keep?: boolean;
  help?: boolean;
}

function parseSnapshotArgs(args: string[]): SnapshotOptions {
  const options: SnapshotOptions = {
    format: 'text',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--format' || arg === '-f') {
      options.format = args[++i] as SnapshotOptions['format'];
      options.formatExplicit = true;
    } else if (arg === '--diff' || arg === '-d') {
      options.diffFile = args[++i];
    } else if (arg === '--interactive' || arg === '-i') {
      options.format = 'interactive';
      options.formatExplicit = true;
    } else if (arg === '--role') {
      options.roles = args[++i]
        ?.split(',')
        .map((role) => role.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg === '--output' || arg === '-o') {
      options.outputFile = args[++i];
    } else if (arg === '--inspect') {
      options.inspect = true;
    } else if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    }
  }

  return options;
}

function writeInfo(message: string, asStderr = false): void {
  const stream = asStderr ? process.stderr : process.stdout;
  stream.write(message.endsWith('\n') ? message : `${message}\n`);
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function snapshotCommand(
  args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  const options = parseSnapshotArgs(args);

  if (options.help || globalOptions.help) {
    console.log(SNAPSHOT_HELP);
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
    const snapshot = await page.snapshot(options.roles?.length ? { roles: options.roles } : {});
    const infoToStderr = globalOptions.format === 'json' || !!options.outputFile;

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
      const parsedBefore: unknown = JSON.parse(beforeContent);
      if (!isRecord(parsedBefore) || !Array.isArray(parsedBefore['accessibilityTree'])) {
        throw new Error('Diff file is not a valid PageSnapshot JSON payload');
      }
      const beforeSnapshot = parsedBefore as unknown as PageSnapshot;
      const diff = diffSnapshots(beforeSnapshot, snapshot);

      if (options.outputFile) {
        fs.writeFileSync(options.outputFile, renderOutput(diff, globalOptions.format));
        writeInfo(`Wrote output to ${options.outputFile}`, true);
      } else if (globalOptions.format === 'json') {
        output(diff, 'json');
      } else {
        writeInfo(formatDiffPretty(diff));
      }
      return;
    }

    // Handle inspect mode
    if (options.inspect) {
      await injectRefOverlay(page, snapshot);
      writeInfo('Overlay injected. Element refs are now visible on the page.', infoToStderr);

      if (options.keep) {
        writeInfo(
          'Overlay will remain visible. Use removeRefOverlay() or refresh the page to remove.',
          infoToStderr
        );
      } else {
        writeInfo('Overlay will be removed in 10 seconds...', infoToStderr);
        await sleep(10000);
        await removeRefOverlay(page);
        writeInfo('Overlay removed.', infoToStderr);
      }
    }

    const shouldForceFullJson = globalOptions.format === 'json' && !options.formatExplicit;
    let payload: PageSnapshot | PageSnapshot['interactiveElements'] | string = snapshot;

    if (!shouldForceFullJson) {
      switch (options.format) {
        case 'interactive':
          payload = snapshot.interactiveElements;
          break;
        case 'text':
          payload = snapshot.text;
          break;
        default:
          payload = snapshot;
          break;
      }
    }

    if (options.outputFile) {
      fs.writeFileSync(options.outputFile, renderOutput(payload, globalOptions.format));
      writeInfo(`Wrote output to ${options.outputFile}`, true);
    } else {
      output(payload, globalOptions.format);
    }
  } finally {
    await browser.disconnect();
  }
}
