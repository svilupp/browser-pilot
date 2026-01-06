/**
 * Record command - Record browser actions to JSON
 *
 * Captures human interactions in a browser session and saves them
 * as JSON steps compatible with page.batch() for replay.
 */

import { type Browser, connect, getBrowserWebSocketUrl } from '../../index.ts';
import { Recorder } from '../../recording/recorder.ts';
import { output } from '../index.ts';
import {
  generateSessionId,
  getDefaultSession,
  loadSession,
  type SessionData,
  saveSession,
  updateSession,
} from '../session.ts';

const RECORD_HELP = `
bp record - Record browser actions to JSON

Usage:
  bp record [options]

Options:
  -s, --session [id]  Session to use:
                        - omit -s: auto-connect to local browser
                        - -s alone: use most recent session
                        - -s <id>: use specific session
  -f, --file <path>   Output file (default: recording.json)
  --timeout <ms>      Auto-stop after timeout (optional)
  -h, --help          Show this help

Examples:
  bp record                        # Auto-connect to local Chrome
  bp record -s                     # Use most recent session
  bp record -s mysession           # Use specific session
  bp record -f login.json          # Save to specific file
  bp record --timeout 60000        # Auto-stop after 60s

Recording captures: clicks, inputs, form submissions, navigation.
Password fields are automatically redacted as [REDACTED].

Press Ctrl+C to stop recording and save.
`;

interface RecordOptions {
  file?: string;
  timeout?: number;
  help?: boolean;
  useLatestSession?: boolean;
}

export function parseRecordArgs(args: string[]): RecordOptions {
  const options: RecordOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '-f' || arg === '--file') {
      options.file = args[++i];
    } else if (arg === '--timeout') {
      options.timeout = Number.parseInt(args[++i] ?? '', 10);
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-s' || arg === '--session') {
      // Check if next arg is a value or another flag (or end of args)
      const nextArg = args[i + 1];
      if (!nextArg || nextArg.startsWith('-')) {
        options.useLatestSession = true;
      }
      // Note: actual session ID value is parsed by main CLI into globalOptions.session
    }
  }

  return options;
}

interface ResolvedConnection {
  browser: Browser;
  session: SessionData;
  isNewSession: boolean;
}

/**
 * Resolve which browser connection to use based on arguments.
 *
 * Three modes:
 * 1. sessionId provided -> use that specific session
 * 2. useLatestSession -> use most recent session
 * 3. neither -> auto-connect to local browser and create new session
 */
async function resolveConnection(
  sessionId: string | undefined,
  useLatestSession: boolean,
  trace: boolean
): Promise<ResolvedConnection> {
  // Mode 1: Specific session ID provided
  if (sessionId) {
    const session = await loadSession(sessionId);
    const browser = await connect({
      provider: session.provider,
      wsUrl: session.wsUrl,
      debug: trace,
    });
    return { browser, session, isNewSession: false };
  }

  // Mode 2: Use latest session (-s flag without value)
  if (useLatestSession) {
    const session = await getDefaultSession();
    if (!session) {
      throw new Error(
        'No sessions found. Run "bp connect" first or use "bp record" to auto-connect.'
      );
    }
    const browser = await connect({
      provider: session.provider,
      wsUrl: session.wsUrl,
      debug: trace,
    });
    return { browser, session, isNewSession: false };
  }

  // Mode 3: Auto-connect to local browser (no -s flag at all)
  let wsUrl: string;
  try {
    wsUrl = await getBrowserWebSocketUrl('localhost:9222');
  } catch {
    throw new Error(
      'Could not auto-discover browser.\n' +
        'Either:\n' +
        '  1. Start Chrome with: --remote-debugging-port=9222\n' +
        '  2. Use an existing session: bp record -s <session-id>\n' +
        '  3. Use latest session: bp record -s'
    );
  }

  const browser = await connect({
    provider: 'generic',
    wsUrl,
    debug: trace,
  });

  // Create and save new session
  const page = await browser.page();
  const currentUrl = await page.url();
  const newSessionId = generateSessionId();

  const session: SessionData = {
    id: newSessionId,
    provider: 'generic',
    wsUrl: browser.wsUrl,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    currentUrl,
  };

  await saveSession(session);

  return { browser, session, isNewSession: true };
}

export async function recordCommand(
  args: string[],
  globalOptions: { session?: string; output?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  const options = parseRecordArgs(args);

  // Show help if requested
  if (options.help || globalOptions.help) {
    console.log(RECORD_HELP);
    return;
  }

  // Default output file
  const outputFile = options.file ?? 'recording.json';

  // Resolve connection (auto-connect, latest session, or specific session)
  const { browser, session, isNewSession } = await resolveConnection(
    globalOptions.session,
    options.useLatestSession ?? false,
    globalOptions.trace ?? false
  );

  if (isNewSession) {
    console.log(`Created new session: ${session.id}`);
  }

  const page = await browser.page();
  const cdp = page.cdpClient;

  // Create recorder
  const recorder = new Recorder(cdp);

  // Track if we're already stopping to prevent double-stop
  let stopping = false;

  // Stop recording and save
  async function stopAndSave(): Promise<void> {
    if (stopping) return;
    stopping = true;

    try {
      const recording = await recorder.stop();

      // Write to file
      const fs = await import('node:fs/promises');
      await fs.writeFile(outputFile, JSON.stringify(recording, null, 2));

      // Update session
      const currentUrl = await page.url();
      await updateSession(session.id, { currentUrl });

      // Disconnect
      await browser.disconnect();

      // Output summary
      console.log(`\nSaved ${recording.steps.length} steps to ${outputFile}`);

      if (globalOptions.output === 'json') {
        output(
          {
            success: true,
            file: outputFile,
            steps: recording.steps.length,
            duration: recording.duration,
          },
          'json'
        );
      }

      process.exit(0);
    } catch (error) {
      console.error('Error saving recording:', error);
      process.exit(1);
    }
  }

  // Handle signals
  process.on('SIGINT', stopAndSave);
  process.on('SIGTERM', stopAndSave);

  // Handle timeout
  if (options.timeout && options.timeout > 0) {
    setTimeout(stopAndSave, options.timeout);
  }

  // Start recording
  await recorder.start();

  console.log(`Recording... Press Ctrl+C to stop and save to ${outputFile}`);
  console.log(`Session: ${session.id}`);
  console.log(`URL: ${await page.url()}`);
}
