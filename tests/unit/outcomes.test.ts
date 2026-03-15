import { describe, expect, it } from 'bun:test';
import { evaluateOutcome } from '../../src/actions/conditions.ts';
import type { Page } from '../../src/browser/page.ts';

function createMockPage(options: { url?: string; text?: string; waitForResult?: boolean } = {}) {
  const { url = 'http://example.com', text = 'Hello World', waitForResult = true } = options;
  return {
    url: async () => url,
    text: async (_selector?: string) => text,
    waitFor: async (
      _sel: string,
      _opts?: { timeout?: number; optional?: boolean; state?: string }
    ) => {
      return waitForResult;
    },
    cdpClient: {
      on: (_event: string, _handler: (...args: unknown[]) => void) => {},
      off: (_event: string, _handler: (...args: unknown[]) => void) => {},
    },
  } as unknown as Page;
}

// ---------------------------------------------------------------------------
// hasOutcomeConditions behavior (through evaluateOutcome)
// ---------------------------------------------------------------------------

describe('empty condition arrays', () => {
  it('all arrays empty returns success with no matched conditions', async () => {
    const page = createMockPage();
    const result = await evaluateOutcome(page, {
      failIf: [],
      expectAll: [],
      expectAny: [],
    });
    expect(result.outcomeStatus).toBe('success');
    expect(result.matchedConditions).toEqual([]);
    expect(result.retrySafe).toBe(true);
  });

  it('undefined arrays returns success', async () => {
    const page = createMockPage();
    const result = await evaluateOutcome(page, {});
    expect(result.outcomeStatus).toBe('success');
    expect(result.matchedConditions).toEqual([]);
  });

  it('non-empty arrays trigger actual evaluation', async () => {
    const page = createMockPage({ text: 'Hello World' });
    const result = await evaluateOutcome(page, {
      expectAny: [{ kind: 'textAppears', text: 'Hello' }],
    });
    expect(result.outcomeStatus).toBe('success');
    expect(result.matchedConditions.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Evaluation order semantics
// ---------------------------------------------------------------------------

describe('evaluation order', () => {
  it('failIf is checked before expectAny/expectAll', async () => {
    const page = createMockPage({
      url: 'https://example.com/error',
      text: 'Error occurred but also has Success marker',
    });
    const result = await evaluateOutcome(page, {
      failIf: [{ kind: 'urlMatches', pattern: '*error*' }],
      expectAll: [{ kind: 'textAppears', text: 'Success marker' }],
      expectAny: [{ kind: 'textAppears', text: 'Success marker' }],
    });
    expect(result.outcomeStatus).toBe('failed');
  });

  it('non-matching failIf does not block success evaluation', async () => {
    const page = createMockPage({
      url: 'https://example.com/ok',
      text: 'Operation complete',
    });
    const result = await evaluateOutcome(page, {
      failIf: [{ kind: 'urlMatches', pattern: '*error*' }],
      expectAll: [{ kind: 'textAppears', text: 'Operation complete' }],
    });
    expect(result.outcomeStatus).toBe('success');
  });

  it('expectAll failure produces ambiguous, not failed', async () => {
    const page = createMockPage({ text: 'Still loading' });
    const result = await evaluateOutcome(page, {
      expectAll: [{ kind: 'textAppears', text: 'Done' }],
    });
    expect(result.outcomeStatus).toBe('ambiguous');
    expect(result.outcomeStatus).not.toBe('failed');
  });

  it('expectAny with at least one match returns success', async () => {
    const page = createMockPage({ text: 'Thank you for your order' });
    const result = await evaluateOutcome(page, {
      expectAny: [
        { kind: 'textAppears', text: 'Order confirmed' },
        { kind: 'textAppears', text: 'Thank you' },
        { kind: 'textAppears', text: 'Receipt sent' },
      ],
    });
    expect(result.outcomeStatus).toBe('success');
  });

  it('expectAny with no matches returns ambiguous', async () => {
    const page = createMockPage({ text: 'Unexpected page' });
    const result = await evaluateOutcome(page, {
      expectAny: [
        { kind: 'textAppears', text: 'Order confirmed' },
        { kind: 'textAppears', text: 'Thank you' },
      ],
    });
    expect(result.outcomeStatus).toBe('ambiguous');
  });

  it('both expectAll and expectAny: expectAll must pass before expectAny is checked', async () => {
    const page = createMockPage({
      url: 'https://example.com/dashboard',
      text: 'Welcome back',
    });
    const result = await evaluateOutcome(page, {
      expectAll: [{ kind: 'urlMatches', pattern: '*dashboard*' }],
      expectAny: [{ kind: 'textAppears', text: 'Welcome back' }],
    });
    expect(result.outcomeStatus).toBe('success');
  });

  it('expectAll failure short-circuits expectAny evaluation', async () => {
    const page = createMockPage({
      url: 'https://example.com/login',
      text: 'Welcome back',
    });
    const result = await evaluateOutcome(page, {
      expectAll: [{ kind: 'urlMatches', pattern: '*dashboard*' }],
      expectAny: [{ kind: 'textAppears', text: 'Welcome back' }],
    });
    // expectAll failed, so it returns ambiguous without checking expectAny
    expect(result.outcomeStatus).toBe('ambiguous');
    // Should only have the expectAll condition evaluated, not the expectAny one
    expect(result.matchedConditions.length).toBe(1);
    expect(result.matchedConditions[0]?.condition.kind).toBe('urlMatches');
  });
});

// ---------------------------------------------------------------------------
// Dangerous flag semantics
// ---------------------------------------------------------------------------

describe('dangerous flag', () => {
  it('ambiguous + dangerous returns unsafe_to_retry', async () => {
    const page = createMockPage({ text: 'Ambiguous state' });
    const result = await evaluateOutcome(page, {
      expectAll: [{ kind: 'textAppears', text: 'Confirmed' }],
      dangerous: true,
    });
    expect(result.outcomeStatus).toBe('unsafe_to_retry');
    expect(result.retrySafe).toBe(false);
  });

  it('failed + dangerous returns retrySafe false', async () => {
    const page = createMockPage({ url: 'https://example.com/error' });
    const result = await evaluateOutcome(page, {
      failIf: [{ kind: 'urlMatches', pattern: '*error*' }],
      dangerous: true,
    });
    expect(result.outcomeStatus).toBe('failed');
    expect(result.retrySafe).toBe(false);
  });

  it('success + dangerous returns retrySafe true', async () => {
    const page = createMockPage({ text: 'Payment confirmed' });
    const result = await evaluateOutcome(page, {
      expectAll: [{ kind: 'textAppears', text: 'Payment confirmed' }],
      dangerous: true,
    });
    expect(result.outcomeStatus).toBe('success');
    expect(result.retrySafe).toBe(true);
  });

  it('non-dangerous ambiguous returns retrySafe true', async () => {
    const page = createMockPage({ text: 'Ambiguous state' });
    const result = await evaluateOutcome(page, {
      expectAll: [{ kind: 'textAppears', text: 'Confirmed' }],
      dangerous: false,
    });
    expect(result.outcomeStatus).toBe('ambiguous');
    expect(result.retrySafe).toBe(true);
  });

  it('non-dangerous failed returns retrySafe true', async () => {
    const page = createMockPage({ url: 'https://example.com/error' });
    const result = await evaluateOutcome(page, {
      failIf: [{ kind: 'urlMatches', pattern: '*error*' }],
      dangerous: false,
    });
    expect(result.outcomeStatus).toBe('failed');
    expect(result.retrySafe).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('all conditions as empty arrays returns success', async () => {
    const page = createMockPage();
    const result = await evaluateOutcome(page, {
      failIf: [],
      expectAll: [],
      expectAny: [],
      dangerous: true,
    });
    expect(result.outcomeStatus).toBe('success');
    expect(result.retrySafe).toBe(true);
  });

  it('single condition in failIf', async () => {
    const page = createMockPage({ url: 'https://example.com/500' });
    const result = await evaluateOutcome(page, {
      failIf: [{ kind: 'urlMatches', pattern: '*500*' }],
    });
    expect(result.outcomeStatus).toBe('failed');
    expect(result.matchedConditions.length).toBe(1);
  });

  it('single condition in expectAll', async () => {
    const page = createMockPage({ text: 'Done' });
    const result = await evaluateOutcome(page, {
      expectAll: [{ kind: 'textAppears', text: 'Done' }],
    });
    expect(result.outcomeStatus).toBe('success');
    expect(result.matchedConditions.length).toBe(1);
  });

  it('single condition in expectAny', async () => {
    const page = createMockPage({ text: 'Done' });
    const result = await evaluateOutcome(page, {
      expectAny: [{ kind: 'textAppears', text: 'Done' }],
    });
    expect(result.outcomeStatus).toBe('success');
    expect(result.matchedConditions.length).toBe(1);
  });

  it('evaluates all expectAny conditions even after a match (for reporting)', async () => {
    const page = createMockPage({ text: 'Both match here' });
    const result = await evaluateOutcome(page, {
      expectAny: [
        { kind: 'textAppears', text: 'Both' },
        { kind: 'textAppears', text: 'match' },
      ],
    });
    expect(result.outcomeStatus).toBe('success');
    // Both conditions should be evaluated and reported
    expect(result.matchedConditions.length).toBe(2);
    expect(result.matchedConditions.every((m) => m.matched)).toBe(true);
  });

  it('failIf with multiple conditions stops at first match', async () => {
    const page = createMockPage({
      url: 'https://example.com/error',
      text: 'Also contains bad text',
    });
    const result = await evaluateOutcome(page, {
      failIf: [
        { kind: 'urlMatches', pattern: '*error*' },
        { kind: 'textAppears', text: 'bad text' },
      ],
    });
    expect(result.outcomeStatus).toBe('failed');
    // Should have only evaluated up to the first matching failIf
    expect(result.matchedConditions.length).toBe(1);
  });
});
