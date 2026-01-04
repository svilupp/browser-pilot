/**
 * Exec command - Execute actions on current session
 */

import { addBatchToPage, connect, type Step } from '../../index.ts';
import { output } from '../index.ts';
import { getDefaultSession, loadSession, type SessionData, updateSession } from '../session.ts';

interface ExecOptions {
  session?: string;
  output?: 'json' | 'pretty';
  trace?: boolean;
  dialog?: 'accept' | 'dismiss';
}

function parseExecArgs(args: string[]): { actionsJson: string | undefined; options: ExecOptions } {
  const options: ExecOptions = {};
  let actionsJson: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--dialog') {
      const value = args[++i];
      if (value === 'accept' || value === 'dismiss') {
        options.dialog = value;
      } else {
        throw new Error('--dialog must be "accept" or "dismiss"');
      }
    } else if (!actionsJson && !arg.startsWith('-')) {
      actionsJson = arg;
    }
  }

  return { actionsJson, options };
}

export async function execCommand(
  args: string[],
  globalOptions: { session?: string; output?: 'json' | 'pretty'; trace?: boolean }
): Promise<void> {
  // Parse exec-specific options
  const { actionsJson, options: execOptions } = parseExecArgs(args);

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

  // Parse actions from arguments
  if (!actionsJson) {
    throw new Error(
      'No actions provided. Usage: bp exec \'{"action":"goto","url":"..."}\'\n\nRun \'bp actions\' for complete action reference.'
    );
  }

  let actions: Step | Step[];
  try {
    actions = JSON.parse(actionsJson);
  } catch {
    throw new Error(
      "Invalid JSON. Actions must be valid JSON.\n\nRun 'bp actions' for complete action reference."
    );
  }

  // Connect to browser
  const browser = await connect({
    provider: session.provider,
    wsUrl: session.wsUrl,
    debug: globalOptions.trace,
  });

  try {
    const page = addBatchToPage(await browser.page());

    // Hydrate ref map from session cache if URL matches
    const currentUrlForCache = await page.url();
    const refCache = session.metadata?.refCache;
    if (refCache && refCache.url === currentUrlForCache) {
      page.importRefMap(refCache.refMap);
    }

    // Set up dialog handling if --dialog flag is provided
    if (execOptions.dialog) {
      await page.onDialog(async (dialog) => {
        if (execOptions.dialog === 'accept') {
          await dialog.accept();
        } else {
          await dialog.dismiss();
        }
      });
    }

    // Execute actions
    const steps = Array.isArray(actions) ? actions : [actions];
    const result = await page.batch(steps);

    // Update session with current URL
    const currentUrl = await page.url();
    const hasSnapshot = steps.some((step) => step.action === 'snapshot');
    if (hasSnapshot) {
      await updateSession(session.id, {
        currentUrl,
        metadata: {
          refCache: {
            url: currentUrl,
            savedAt: new Date().toISOString(),
            refMap: page.exportRefMap(),
          },
        },
      });
    } else {
      await updateSession(session.id, { currentUrl });
    }

    // Output result
    output(
      {
        success: result.success,
        stoppedAtIndex: result.stoppedAtIndex,
        steps: result.steps.map((s) => ({
          action: s.action,
          success: s.success,
          durationMs: s.durationMs,
          selectorUsed: s.selectorUsed,
          error: s.error,
          text: s.text,
          result: s.result,
        })),
        totalDurationMs: result.totalDurationMs,
        currentUrl,
      },
      globalOptions.output
    );
  } finally {
    await browser.disconnect();
  }
}
