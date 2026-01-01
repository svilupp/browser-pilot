/**
 * Close command - Close a browser session
 */

import { connect } from '../../index.ts';
import { output } from '../index.ts';
import { deleteSession, getDefaultSession, loadSession, type SessionData } from '../session.ts';

export async function closeCommand(
  args: string[],
  globalOptions: { session?: string; output?: 'json' | 'pretty'; trace?: boolean }
): Promise<void> {
  // Get session
  let session: SessionData | null;
  if (globalOptions.session) {
    session = await loadSession(globalOptions.session);
  } else if (args[0]) {
    session = await loadSession(args[0]);
  } else {
    session = await getDefaultSession();
    if (!session) {
      throw new Error('No session found. Specify a session ID or run "bp list" to see sessions.');
    }
  }

  try {
    // Try to connect and close the browser
    const browser = await connect({
      provider: session.provider,
      wsUrl: session.wsUrl,
      debug: globalOptions.trace,
    });

    await browser.close();
  } catch {
    // Browser might already be closed, that's ok
  }

  // Delete session file
  await deleteSession(session.id);

  output(
    {
      success: true,
      sessionId: session.id,
      message: 'Session closed',
    },
    globalOptions.output
  );
}
