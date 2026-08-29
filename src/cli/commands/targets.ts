import type { TargetInfo } from '../../cdp/protocol.ts';
import { attachSession } from '../attach.ts';
import { output } from '../output.ts';
import { getDefaultSession, loadSession } from '../session.ts';

const TARGETS_HELP = `
bp targets - List page tabs available in the connected browser

Usage:
  bp targets [options]

Global options:
  -s, --session <id>   Session to use (default: most recent)
  --json               Output JSON
  --pretty             Output readable text (default)
  --debug              Enable CDP transport debugging
  -h, --help           Show this help

Examples:
  bp targets
  bp targets --json

The current session target is marked with "current: true". "attached" only
means some CDP client is attached; it does not identify the tab this session uses.
`.trimEnd();

type ListedTarget = TargetInfo & { current: boolean };

function formatTargetsPretty(targets: ListedTarget[]): string {
  if (targets.length === 0) {
    return 'No page targets found.';
  }

  return targets
    .map((target) => {
      const lines = [
        `${target.current ? '* ' : '  '}${target.title || '(untitled)'}`,
        `  targetId: ${target.targetId}`,
        `  url: ${target.url}`,
      ];
      if (target.current) {
        lines.push('  current: true');
      }
      if (target.attached) {
        lines.push('  attached: true');
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

export async function targetsCommand(
  _args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  if (globalOptions.help) {
    process.stdout.write(`${TARGETS_HELP}\n`);
    return;
  }

  const session = globalOptions.session
    ? await loadSession(globalOptions.session)
    : await getDefaultSession();

  if (!session) {
    throw new Error('No session found. Run "bp connect" first.');
  }

  const { browser } = await attachSession(session, { trace: globalOptions.trace });

  try {
    const targets = (await browser.listTargets()).map((target) => ({
      ...target,
      current: target.targetId === session.targetId,
    }));
    output(
      globalOptions.format === 'json' ? targets : formatTargetsPretty(targets),
      globalOptions.format
    );
  } finally {
    await browser.disconnect();
  }
}
