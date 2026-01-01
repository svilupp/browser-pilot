/**
 * List command - List all sessions
 */

import { output } from '../index.ts';
import { listSessions } from '../session.ts';

export async function listCommand(
  _args: string[],
  globalOptions: { session?: string; output?: 'json' | 'pretty'; trace?: boolean }
): Promise<void> {
  const sessions = await listSessions();

  if (globalOptions.output === 'json') {
    output(sessions, 'json');
    return;
  }

  if (sessions.length === 0) {
    console.log('No active sessions.');
    console.log('Run "bp connect" to create a new session.');
    return;
  }

  console.log('Active Sessions:\n');

  for (const session of sessions) {
    const age = getAge(new Date(session.lastActivity));
    console.log(`  ${session.id}`);
    console.log(`    Provider: ${session.provider}`);
    console.log(`    URL: ${session.currentUrl}`);
    console.log(`    Last activity: ${age}`);
    console.log('');
  }
}

function getAge(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
