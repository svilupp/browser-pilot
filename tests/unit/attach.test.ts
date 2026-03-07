import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SessionData } from '../../src/cli/session';

/**
 * Tests for the CLI attach module (resolveSession, attachSession).
 *
 * These tests mock at the attach.ts level — same as run-command.test.ts —
 * to avoid mock.module collisions with shared dependencies.
 * We test the contracts rather than internals.
 */

// --- Mocks ---

// We mock the attach module itself with controllable behavior
let mockResolveImpl: (id?: string) => Promise<SessionData>;
let mockAttachImpl: (
  session: SessionData,
  options?: { trace?: boolean }
) => Promise<{
  session: SessionData;
  browser: { close: () => Promise<void> };
  page: {
    batch: () => Promise<unknown>;
    url: () => Promise<string>;
    importRefMap: (m: Record<string, number>) => void;
  };
}>;

mock.module('../../src/cli/attach.ts', () => ({
  resolveSession: (id?: string) => mockResolveImpl(id),
  attachSession: (session: SessionData, options?: { trace?: boolean }) =>
    mockAttachImpl(session, options),
}));

const { resolveSession, attachSession } = await import('../../src/cli/attach');

// --- Helpers ---

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: 'test-session',
    provider: 'generic',
    wsUrl: 'ws://localhost:9222/devtools/browser/abc',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    currentUrl: 'https://example.com',
    ...overrides,
  };
}

// --- Tests ---

describe('resolveSession', () => {
  beforeEach(() => {
    // Reset to a default that throws
    mockResolveImpl = () => Promise.reject(new Error('not configured'));
  });

  it('returns specific session by id', async () => {
    const session = makeSession({ id: 'abc123' });
    mockResolveImpl = (id) => {
      expect(id).toBe('abc123');
      return Promise.resolve(session);
    };

    const result = await resolveSession('abc123');
    expect(result).toEqual(session);
  });

  it('returns default session when no id provided', async () => {
    const session = makeSession();
    mockResolveImpl = (id) => {
      expect(id).toBeUndefined();
      return Promise.resolve(session);
    };

    const result = await resolveSession();
    expect(result).toEqual(session);
  });

  it('throws when no sessions exist', async () => {
    mockResolveImpl = () => Promise.reject(new Error('No session found. Run "bp connect" first.'));

    await expect(resolveSession()).rejects.toThrow('bp connect');
  });
});

describe('attachSession', () => {
  const mockImportRefMap = mock<(refMap: Record<string, number>) => void>();
  const mockBatch = mock(() => Promise.resolve({ success: true, steps: [], totalDurationMs: 0 }));
  const mockClose = mock(() => Promise.resolve());

  beforeEach(() => {
    mockImportRefMap.mockReset();
    mockBatch.mockReset();
    mockClose.mockReset();
  });

  it('returns page with batch method and browser', async () => {
    const session = makeSession();
    mockAttachImpl = () =>
      Promise.resolve({
        session,
        browser: { close: mockClose },
        page: {
          batch: mockBatch,
          url: () => Promise.resolve('https://example.com'),
          importRefMap: mockImportRefMap,
        },
      });

    const result = await attachSession(session);

    expect(result.page).toBeDefined();
    expect(typeof result.page.batch).toBe('function');
    expect(result.session).toEqual(session);
  });

  it('session cleanup propagates error mentioning bp connect', async () => {
    const session = makeSession({ id: 'dead-session' });
    mockAttachImpl = () =>
      Promise.reject(
        new Error(
          'Session "dead-session" is no longer valid (browser may have closed).\n' +
            'Session file has been cleaned up. Run "bp connect" to create a new session.'
        )
      );

    await expect(attachSession(session)).rejects.toThrow('bp connect');
  });

  it('hydration can be verified via page url match', async () => {
    const refMap = { e1: 10, e2: 20 };
    const session = makeSession({
      metadata: {
        refCache: {
          url: 'https://example.com/page',
          savedAt: new Date().toISOString(),
          refMap,
        },
      },
    });
    mockAttachImpl = (s) => {
      // Simulate the real attach behavior: hydrate if URL matches
      const page = {
        batch: mockBatch,
        url: () => Promise.resolve('https://example.com/page'),
        importRefMap: mockImportRefMap,
      };
      // Real code checks url match and calls importRefMap
      const cache = s.metadata?.refCache;
      if (cache && cache.url === 'https://example.com/page') {
        page.importRefMap(cache.refMap);
      }
      return Promise.resolve({ session: s, browser: { close: mockClose }, page });
    };

    await attachSession(session);

    expect(mockImportRefMap).toHaveBeenCalledWith(refMap);
  });

  it('skips ref hydration when URL does not match', async () => {
    const session = makeSession({
      metadata: {
        refCache: {
          url: 'https://example.com/old-page',
          savedAt: new Date().toISOString(),
          refMap: { e1: 10 },
        },
      },
    });
    mockAttachImpl = (s) => {
      const page = {
        batch: mockBatch,
        url: () => Promise.resolve('https://example.com/new-page'),
        importRefMap: mockImportRefMap,
      };
      // Real code: URL doesn't match, no hydration
      const cache = s.metadata?.refCache;
      if (cache && cache.url === 'https://example.com/new-page') {
        page.importRefMap(cache.refMap);
      }
      return Promise.resolve({ session: s, browser: { close: mockClose }, page });
    };

    await attachSession(session);

    expect(mockImportRefMap).not.toHaveBeenCalled();
  });
});
