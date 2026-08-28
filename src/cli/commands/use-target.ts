/** Explicitly switch a named CLI session to an existing browser tab. */

import { attachSession, resolveSession } from '../attach.ts';
import { output } from '../output.ts';
import { updateSession } from '../session.ts';

const USE_TARGET_HELP = `
bp use-target - Explicitly switch a session to a browser tab

Usage:
  bp use-target <target-id> [options]

The target ID must be an existing page target. This command updates the named
session's pinned target; it never falls back to another tab.

Options:
  --target-id <id>      Long-form target ID (or pass it positionally)
  -s, --session <id>    Session to update (default: most recent)
  --json                Output JSON
  --pretty              Output readable text (default)
  -h, --help            Show this help
`.trimEnd();

export async function useTargetCommand(
  args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; help?: boolean }
): Promise<void> {
  if (globalOptions.help) {
    process.stdout.write(`${USE_TARGET_HELP}\n`);
    return;
  }

  let targetId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--target-id') targetId = args[++i];
    else if (!targetId && !arg.startsWith('-')) targetId = arg;
  }
  if (!targetId) {
    throw new Error('use-target requires a target ID. Run "bp targets --json" to list tabs.');
  }

  const session = await resolveSession(globalOptions.session);
  const { browser } = await attachSession(session);

  try {
    const target = (await browser.listTargets()).find(
      (candidate) => candidate.targetId === targetId
    );
    if (!target) {
      throw new Error(
        `Target ${JSON.stringify(targetId)} was not found. Run "bp targets --json" and choose an existing page target.`
      );
    }

    const page = await browser.page(undefined, { targetId });
    const currentUrl = await page.url();
    await updateSession(session.id, { targetId, currentUrl });
    output(
      {
        success: true,
        sessionId: session.id,
        targetId,
        currentUrl,
        title: target.title,
        switchedFrom: session.targetId,
        targetProvenance: page.getTargetProvenance(),
      },
      globalOptions.format
    );
  } finally {
    await browser.disconnect();
  }
}
