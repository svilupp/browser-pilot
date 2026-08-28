import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION_DIR = join(homedir(), '.browser-pilot', 'sessions');
const SESSION_SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const NEWEST_SESSION_ID = `bp-clean-newest-${SESSION_SUFFIX}`;
const OLDEST_SESSION_ID = `bp-clean-oldest-${SESSION_SUFFIX}`;

const deleteCalls: string[] = [];
const stopCalls: number[] = [];
const actualSessionModule = await import(
  new URL('../../src/cli/session.ts?actual', import.meta.url).href
);
const actualDaemonLifecycle = await import(
  new URL('../../src/daemon/lifecycle.ts?actual', import.meta.url).href
);

let sessions: Array<{
  id: string;
  wsUrl: string;
  lastActivity: string;
  daemon?: { pid: number; socketPath: string };
}> = [];

mock.module('../../src/cli/session.ts', () => ({
  ...actualSessionModule,
  listSessions: () => Promise.resolve(sessions),
  deleteSessionFull: (id: string) => {
    deleteCalls.push(id);
    return Promise.resolve();
  },
}));

mock.module('../../src/daemon/lifecycle.ts', () => ({
  ...actualDaemonLifecycle,
  stopDaemon: (pid: number) => {
    stopCalls.push(pid);
    return Promise.resolve(true);
  },
}));

void mock.module('../../src/daemon/control.ts', () => ({
  daemonControlMatches: () => Promise.resolve(true),
}));

const { cleanCommand } = await import('../../src/cli/commands/clean.ts');

async function createSessionArtifacts(sessionId: string, bytes: number): Promise<void> {
  const sessionFile = join(SESSION_DIR, `${sessionId}.json`);
  const sessionDir = join(SESSION_DIR, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  await writeFile(sessionFile, 'x'.repeat(bytes));
  await writeFile(join(sessionDir, 'log.jsonl'), 'x'.repeat(bytes));
}

function removeSessionArtifacts(sessionId: string): void {
  fs.rmSync(join(SESSION_DIR, sessionId), { force: true, recursive: true });
  fs.rmSync(join(SESSION_DIR, `${sessionId}.json`), { force: true });
}

async function captureJsonOutput(fn: () => Promise<void>): Promise<Record<string, unknown>> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    return true;
  }) as typeof process.stdout.write;

  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }

  return JSON.parse(output) as Record<string, unknown>;
}

describe('bp clean --max-size', () => {
  beforeEach(async () => {
    deleteCalls.length = 0;
    stopCalls.length = 0;
    sessions = [
      {
        id: NEWEST_SESSION_ID,
        wsUrl: 'ws://localhost/devtools/browser/newest',
        lastActivity: '2026-03-09T10:00:00.000Z',
      },
      {
        id: OLDEST_SESSION_ID,
        wsUrl: 'ws://localhost/devtools/browser/oldest',
        lastActivity: '2026-03-09T09:00:00.000Z',
        daemon: { pid: process.pid, socketPath: '/tmp/browser-pilot-clean-test.sock' },
      },
    ];
    await createSessionArtifacts(NEWEST_SESSION_ID, 400);
    await createSessionArtifacts(OLDEST_SESSION_ID, 300);
  });

  afterEach(() => {
    removeSessionArtifacts(NEWEST_SESSION_ID);
    removeSessionArtifacts(OLDEST_SESSION_ID);
  });

  test('removes the oldest sessions until under the size limit and stops daemons first', async () => {
    const payload = await captureJsonOutput(() =>
      cleanCommand(['--max-size', '1KB'], { format: 'json' })
    );

    expect(stopCalls).toEqual([process.pid]);
    expect(deleteCalls).toEqual([OLDEST_SESSION_ID]);
    expect(payload).toEqual({
      message: 'Cleaned 1 session(s)',
      cleaned: 1,
      sessions: [OLDEST_SESSION_ID],
    });
  });

  test('dry-run does not stop daemons or delete sessions', async () => {
    const payload = await captureJsonOutput(() =>
      cleanCommand(['--max-size', '1KB', '--dry-run'], { format: 'json' })
    );

    expect(stopCalls).toEqual([]);
    expect(deleteCalls).toEqual([]);
    expect(payload).toEqual({
      message: 'Would clean 1 session(s)',
      sessions: [OLDEST_SESSION_ID],
      dryRun: true,
    });
  });

  test('reports when the newest session alone is still over the size limit', async () => {
    removeSessionArtifacts(NEWEST_SESSION_ID);
    removeSessionArtifacts(OLDEST_SESSION_ID);

    sessions = [
      {
        id: NEWEST_SESSION_ID,
        wsUrl: 'ws://localhost/devtools/browser/newest',
        lastActivity: '2026-03-09T10:00:00.000Z',
        daemon: { pid: process.pid, socketPath: '/tmp/browser-pilot-clean-test.sock' },
      },
    ];
    await createSessionArtifacts(NEWEST_SESSION_ID, 700);

    const payload = await captureJsonOutput(() =>
      cleanCommand(['--max-size', '1KB'], { format: 'json' })
    );

    expect(stopCalls).toEqual([]);
    expect(deleteCalls).toEqual([]);
    expect(payload).toEqual({
      message: 'Cannot reduce below 1.4KB without removing the newest session',
      cleaned: 0,
      kept: NEWEST_SESSION_ID,
      withinLimit: false,
    });
  });
});
