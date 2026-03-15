import { describe, expect, it } from 'bun:test';
import {
  conditionAll,
  conditionAny,
  conditionNot,
  conditionRace,
} from '../../src/actions/combinators.ts';
import type { Condition } from '../../src/actions/types.ts';
import type { Page } from '../../src/browser/page.ts';

function createMockPage(options: { url?: string; text?: string; waitForResult?: boolean } = {}) {
  const { url = 'http://example.com', text = 'Hello World', waitForResult = true } = options;
  return {
    url: async () => url,
    text: async (_sel?: string) => text,
    title: async () => 'Test',
    waitFor: async (_sel: string, _opts?: Record<string, unknown>) => waitForResult,
    cdpClient: {
      on: (_event: string, _handler: (...args: unknown[]) => void) => {},
      off: (_event: string, _handler: (...args: unknown[]) => void) => {},
    },
  } as unknown as Page;
}

describe('conditionAny', () => {
  it('succeeds when one condition matches', async () => {
    const page = createMockPage({ url: 'http://example.com/success' });
    const conditions: Condition[] = [
      { kind: 'urlMatches', pattern: '*fail*' },
      { kind: 'urlMatches', pattern: '*success*' },
    ];

    const result = await conditionAny(conditions, page);

    expect(result.matched).toBe(true);
    expect(result.winnerIndex).toBe(1);
    expect(result.matchedConditions).toHaveLength(2);
  });

  it('fails when no conditions match', async () => {
    const page = createMockPage({ url: 'http://example.com' });
    const conditions: Condition[] = [
      { kind: 'urlMatches', pattern: '*fail*' },
      { kind: 'urlMatches', pattern: '*notfound*' },
    ];

    const result = await conditionAny(conditions, page);

    expect(result.matched).toBe(false);
    expect(result.winnerIndex).toBeUndefined();
  });

  it('reports first match as winner when all match', async () => {
    const page = createMockPage({ url: 'http://example.com/test', text: 'Hello World' });
    const conditions: Condition[] = [
      { kind: 'urlMatches', pattern: '*example*' },
      { kind: 'textAppears', text: 'Hello' },
    ];

    const result = await conditionAny(conditions, page);

    expect(result.matched).toBe(true);
    expect(result.winnerIndex).toBe(0);
  });
});

describe('conditionAll', () => {
  it('succeeds when all conditions match', async () => {
    const page = createMockPage({ url: 'http://example.com/test', text: 'Hello World' });
    const conditions: Condition[] = [
      { kind: 'urlMatches', pattern: '*example*' },
      { kind: 'textAppears', text: 'Hello' },
    ];

    const result = await conditionAll(conditions, page);

    expect(result.matched).toBe(true);
    expect(result.matchedConditions).toHaveLength(2);
    expect(result.winnerIndex).toBeUndefined();
  });

  it('fails when some conditions do not match', async () => {
    const page = createMockPage({ url: 'http://example.com/test', text: 'Hello World' });
    const conditions: Condition[] = [
      { kind: 'urlMatches', pattern: '*example*' },
      { kind: 'textAppears', text: 'Goodbye' },
    ];

    const result = await conditionAll(conditions, page);

    expect(result.matched).toBe(false);
    // Both conditions are still evaluated
    expect(result.matchedConditions).toHaveLength(2);
    expect(result.matchedConditions[0]!.matched).toBe(true);
    expect(result.matchedConditions[1]!.matched).toBe(false);
  });
});

describe('conditionNot', () => {
  it('inverts true to false', async () => {
    const page = createMockPage({ url: 'http://example.com/test' });
    const condition: Condition = { kind: 'urlMatches', pattern: '*example*' };

    const result = await conditionNot(condition, page);

    expect(result.matched).toBe(false);
    expect(result.matchedConditions).toHaveLength(1);
    expect(result.matchedConditions[0]!.detail).toContain('NOT: condition was true');
  });

  it('inverts false to true', async () => {
    const page = createMockPage({ url: 'http://example.com/test' });
    const condition: Condition = { kind: 'urlMatches', pattern: '*notfound*' };

    const result = await conditionNot(condition, page);

    expect(result.matched).toBe(true);
    expect(result.matchedConditions).toHaveLength(1);
    expect(result.matchedConditions[0]!.detail).toContain('NOT: condition was false');
  });
});

describe('conditionRace', () => {
  it('returns immediately when a condition matches on first check', async () => {
    const page = createMockPage({ url: 'http://example.com/done' });
    const conditions: Condition[] = [
      { kind: 'urlMatches', pattern: '*done*' },
      { kind: 'textAppears', text: 'not here' },
    ];

    const start = Date.now();
    const result = await conditionRace(conditions, page, { timeout: 5000 });
    const elapsed = Date.now() - start;

    expect(result.matched).toBe(true);
    expect(result.winnerIndex).toBe(0);
    // Should be near-instant, well under timeout
    expect(elapsed).toBeLessThan(1000);
  });

  it('returns unmatched result after timeout', async () => {
    const page = createMockPage({ url: 'http://example.com', text: 'nothing' });
    const conditions: Condition[] = [
      { kind: 'urlMatches', pattern: '*notfound*' },
      { kind: 'textAppears', text: 'absent' },
    ];

    const start = Date.now();
    const result = await conditionRace(conditions, page, { timeout: 300, pollInterval: 100 });
    const elapsed = Date.now() - start;

    expect(result.matched).toBe(false);
    expect(result.winnerIndex).toBeUndefined();
    // Should have waited at least the timeout
    expect(elapsed).toBeGreaterThanOrEqual(250);
  });

  it('tracks winnerIndex correctly', async () => {
    const page = createMockPage({ url: 'http://example.com', text: 'Found it' });
    const conditions: Condition[] = [
      { kind: 'urlMatches', pattern: '*notfound*' },
      { kind: 'textAppears', text: 'Found it' },
    ];

    const result = await conditionRace(conditions, page, { timeout: 1000 });

    expect(result.matched).toBe(true);
    expect(result.winnerIndex).toBe(1);
  });
});
