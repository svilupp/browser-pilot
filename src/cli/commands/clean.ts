/**
 * Clean command - Remove stale sessions
 */

import { output } from '../index.ts';
import { deleteSession, listSessions } from '../session.ts';

interface CleanOptions {
  maxAge?: number; // hours
  dryRun?: boolean;
  all?: boolean;
}

function parseCleanArgs(args: string[]): CleanOptions {
  const options: CleanOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--max-age') {
      const value = args[++i];
      options.maxAge = parseInt(value ?? '24', 10);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--all') {
      options.all = true;
    }
  }

  return options;
}

export async function cleanCommand(
  args: string[],
  globalOptions: { output?: 'json' | 'pretty' }
): Promise<void> {
  const options = parseCleanArgs(args);
  const maxAgeMs = (options.maxAge ?? 24) * 60 * 60 * 1000; // Default 24 hours
  const now = Date.now();

  const sessions = await listSessions();
  const stale = sessions.filter((s) => {
    if (options.all) return true;
    const age = now - new Date(s.lastActivity).getTime();
    return age > maxAgeMs;
  });

  if (stale.length === 0) {
    output({ message: 'No stale sessions found', cleaned: 0 }, globalOptions.output);
    return;
  }

  if (options.dryRun) {
    output(
      {
        message: `Would clean ${stale.length} session(s)`,
        sessions: stale.map((s) => s.id),
        dryRun: true,
      },
      globalOptions.output
    );
    return;
  }

  for (const session of stale) {
    await deleteSession(session.id);
  }

  output(
    {
      message: `Cleaned ${stale.length} session(s)`,
      cleaned: stale.length,
      sessions: stale.map((s) => s.id),
    },
    globalOptions.output
  );
}
