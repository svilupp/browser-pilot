/**
 * Exec command - Execute actions on current session
 */

import { addBatchToPage, connect, type Step } from '../../index.ts';
import { output } from '../index.ts';
import { getDefaultSession, loadSession, type SessionData, updateSession } from '../session.ts';

export async function execCommand(
  args: string[],
  globalOptions: { session?: string; output?: 'json' | 'pretty'; trace?: boolean }
): Promise<void> {
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
  const actionsJson = args[0];
  if (!actionsJson) {
    throw new Error('No actions provided. Usage: bp exec \'{"action":"goto","url":"..."}\'');
  }

  let actions: Step | Step[];
  try {
    actions = JSON.parse(actionsJson);
  } catch {
    throw new Error('Invalid JSON. Actions must be valid JSON.');
  }

  // Connect to browser
  const browser = await connect({
    provider: session.provider,
    wsUrl: session.wsUrl,
    debug: globalOptions.trace,
  });

  try {
    const page = addBatchToPage(await browser.page());

    // Execute actions
    const steps = Array.isArray(actions) ? actions : [actions];
    const result = await page.batch(steps);

    // Update session with current URL
    const currentUrl = await page.url();
    await updateSession(session.id, { currentUrl });

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
