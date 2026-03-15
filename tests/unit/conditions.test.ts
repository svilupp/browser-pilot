import { describe, expect, it } from 'bun:test';
import {
  captureStateSignature,
  evaluateCondition,
  evaluateOutcome,
  NetworkResponseTracker,
} from '../../src/actions/conditions.ts';
import type { Condition } from '../../src/actions/types.ts';
import type { Page } from '../../src/browser/page.ts';
import type { CDPClient } from '../../src/cdp/client.ts';

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
// evaluateCondition
// ---------------------------------------------------------------------------

describe('evaluateCondition', () => {
  describe('urlMatches', () => {
    it('matches when URL fits the glob pattern', async () => {
      const page = createMockPage({ url: 'https://example.com/dashboard' });
      const condition: Condition = { kind: 'urlMatches', pattern: '*dashboard*' };
      const result = await evaluateCondition(condition, page);
      expect(result.matched).toBe(true);
      expect(result.detail).toContain('matches');
    });

    it('does not match when URL does not fit the pattern', async () => {
      const page = createMockPage({ url: 'https://example.com/login' });
      const condition: Condition = { kind: 'urlMatches', pattern: '*dashboard*' };
      const result = await evaluateCondition(condition, page);
      expect(result.matched).toBe(false);
      expect(result.detail).toContain('does not match');
    });

    it('matches exact URL pattern', async () => {
      const page = createMockPage({ url: 'https://example.com' });
      const condition: Condition = { kind: 'urlMatches', pattern: 'https://example.com' };
      const result = await evaluateCondition(condition, page);
      expect(result.matched).toBe(true);
    });

    it('supports wildcard at the end', async () => {
      const page = createMockPage({ url: 'https://example.com/foo/bar' });
      const condition: Condition = { kind: 'urlMatches', pattern: 'https://example.com/*' };
      const result = await evaluateCondition(condition, page);
      expect(result.matched).toBe(true);
    });
  });

  describe('elementVisible', () => {
    it('matches when element is visible', async () => {
      const page = createMockPage({ waitForResult: true });
      const condition: Condition = { kind: 'elementVisible', selector: '#btn' };
      const result = await evaluateCondition(condition, page);
      expect(result.matched).toBe(true);
      expect(result.detail).toContain('visible');
    });

    it('does not match when element is not visible', async () => {
      const page = createMockPage({ waitForResult: false });
      const condition: Condition = { kind: 'elementVisible', selector: '#btn' };
      const result = await evaluateCondition(condition, page);
      expect(result.matched).toBe(false);
    });

    it('accepts array of selectors and matches if any is visible', async () => {
      let callCount = 0;
      const page = createMockPage();
      (page as unknown as Record<string, unknown>)['waitFor'] = async () => {
        callCount++;
        return callCount === 2; // second selector succeeds
      };
      const condition: Condition = {
        kind: 'elementVisible',
        selector: ['#first', '#second'],
      };
      const result = await evaluateCondition(condition, page);
      expect(result.matched).toBe(true);
    });
  });

  describe('elementHidden', () => {
    it('matches when element is not visible', async () => {
      const page = createMockPage({ waitForResult: false });
      const condition: Condition = { kind: 'elementHidden', selector: '.modal' };
      const result = await evaluateCondition(condition, page);
      expect(result.matched).toBe(true);
      expect(result.detail).toContain('hidden');
    });

    it('does not match when element is still visible', async () => {
      const page = createMockPage({ waitForResult: true });
      const condition: Condition = { kind: 'elementHidden', selector: '.modal' };
      const result = await evaluateCondition(condition, page);
      expect(result.matched).toBe(false);
      expect(result.detail).toContain('still visible');
    });
  });

  describe('textAppears', () => {
    it('matches when text is found on the page', async () => {
      const page = createMockPage({ text: 'Welcome to the dashboard' });
      const condition: Condition = { kind: 'textAppears', text: 'Welcome' };
      const result = await evaluateCondition(condition, page);
      expect(result.matched).toBe(true);
      expect(result.detail).toContain('found');
    });

    it('does not match when text is absent', async () => {
      const page = createMockPage({ text: 'Welcome to the dashboard' });
      const condition: Condition = { kind: 'textAppears', text: 'Goodbye' };
      const result = await evaluateCondition(condition, page);
      expect(result.matched).toBe(false);
      expect(result.detail).toContain('not found');
    });

    it('accepts optional selector', async () => {
      const page = createMockPage({ text: 'Inside element' });
      const condition: Condition = {
        kind: 'textAppears',
        selector: '#content',
        text: 'Inside',
      };
      const result = await evaluateCondition(condition, page);
      expect(result.matched).toBe(true);
    });
  });

  describe('textChanges', () => {
    it('matches when `to` text is found', async () => {
      const page = createMockPage({ text: 'Updated content here' });
      const condition: Condition = { kind: 'textChanges', to: 'Updated' };
      const result = await evaluateCondition(condition, page);
      expect(result.matched).toBe(true);
      expect(result.detail).toContain('changed to');
    });

    it('does not match when `to` text is absent', async () => {
      const page = createMockPage({ text: 'Old content here' });
      const condition: Condition = { kind: 'textChanges', to: 'Updated' };
      const result = await evaluateCondition(condition, page);
      expect(result.matched).toBe(false);
    });

    it('defaults to true when `to` is not specified', async () => {
      const page = createMockPage({ text: 'Anything' });
      const condition: Condition = { kind: 'textChanges' };
      const result = await evaluateCondition(condition, page);
      expect(result.matched).toBe(true);
      expect(result.detail).toContain('defaults to true');
    });
  });

  describe('networkResponse', () => {
    it('matches when tracker has a matching response', async () => {
      const page = createMockPage();
      const tracker = new NetworkResponseTracker();
      // Manually inject responses via the tracker
      (tracker as unknown as { responses: Array<{ url: string; status: number }> }).responses = [
        { url: 'https://api.example.com/users', status: 200 },
      ];
      const condition: Condition = {
        kind: 'networkResponse',
        urlPattern: '*api.example.com*',
      };
      const result = await evaluateCondition(condition, page, {
        networkTracker: tracker,
      });
      expect(result.matched).toBe(true);
    });

    it('does not match when no responses match the pattern', async () => {
      const page = createMockPage();
      const tracker = new NetworkResponseTracker();
      (tracker as unknown as { responses: Array<{ url: string; status: number }> }).responses = [
        { url: 'https://cdn.example.com/image.png', status: 200 },
      ];
      const condition: Condition = {
        kind: 'networkResponse',
        urlPattern: '*api.example.com*',
      };
      const result = await evaluateCondition(condition, page, {
        networkTracker: tracker,
      });
      expect(result.matched).toBe(false);
    });

    it('filters by status code when specified', async () => {
      const page = createMockPage();
      const tracker = new NetworkResponseTracker();
      (tracker as unknown as { responses: Array<{ url: string; status: number }> }).responses = [
        { url: 'https://api.example.com/save', status: 500 },
      ];
      const condition: Condition = {
        kind: 'networkResponse',
        urlPattern: '*api.example.com*',
        status: 200,
      };
      const result = await evaluateCondition(condition, page, {
        networkTracker: tracker,
      });
      expect(result.matched).toBe(false);
    });

    it('returns not matched when no tracker is provided', async () => {
      const page = createMockPage();
      const condition: Condition = {
        kind: 'networkResponse',
        urlPattern: '*anything*',
      };
      const result = await evaluateCondition(condition, page);
      expect(result.matched).toBe(false);
      expect(result.detail).toContain('No network tracker');
    });
  });

  describe('stateSignatureChanges', () => {
    it('matches when page state has changed', async () => {
      const page = createMockPage({ url: 'https://new.com', text: 'New content' });
      const condition: Condition = { kind: 'stateSignatureChanges' };
      const result = await evaluateCondition(condition, page, {
        beforeSignature: 'https://old.com|abc123',
      });
      expect(result.matched).toBe(true);
      expect(result.detail).toContain('changed');
    });

    it('does not match when page state is unchanged', async () => {
      const page = createMockPage({ url: 'http://example.com', text: 'Hello World' });
      // Capture the actual signature first so we can feed it back
      const sig = await captureStateSignature(page);
      const condition: Condition = { kind: 'stateSignatureChanges' };
      const result = await evaluateCondition(condition, page, {
        beforeSignature: sig,
      });
      expect(result.matched).toBe(false);
      expect(result.detail).toContain('unchanged');
    });

    it('returns not matched when no before-signature is captured', async () => {
      const page = createMockPage();
      const condition: Condition = { kind: 'stateSignatureChanges' };
      const result = await evaluateCondition(condition, page);
      expect(result.matched).toBe(false);
      expect(result.detail).toContain('No before-signature');
    });
  });
});

// ---------------------------------------------------------------------------
// evaluateOutcome
// ---------------------------------------------------------------------------

describe('evaluateOutcome', () => {
  it('returns failed when any failIf condition matches', async () => {
    const page = createMockPage({ url: 'https://example.com/error' });
    const result = await evaluateOutcome(page, {
      failIf: [{ kind: 'urlMatches', pattern: '*error*' }],
      expectAny: [{ kind: 'textAppears', text: 'Hello World' }],
    });
    expect(result.outcomeStatus).toBe('failed');
  });

  it('failIf takes precedence over expectAll and expectAny', async () => {
    const page = createMockPage({
      url: 'https://example.com/error',
      text: 'Expected text is here',
    });
    const result = await evaluateOutcome(page, {
      failIf: [{ kind: 'urlMatches', pattern: '*error*' }],
      expectAll: [{ kind: 'textAppears', text: 'Expected text' }],
      expectAny: [{ kind: 'textAppears', text: 'Expected text' }],
    });
    expect(result.outcomeStatus).toBe('failed');
  });

  it('returns success when all expectAll conditions pass', async () => {
    const page = createMockPage({ url: 'https://example.com/dashboard', text: 'Welcome' });
    const result = await evaluateOutcome(page, {
      expectAll: [
        { kind: 'urlMatches', pattern: '*dashboard*' },
        { kind: 'textAppears', text: 'Welcome' },
      ],
    });
    expect(result.outcomeStatus).toBe('success');
    expect(result.retrySafe).toBe(true);
  });

  it('returns ambiguous when expectAll has unmet conditions', async () => {
    const page = createMockPage({ url: 'https://example.com/loading', text: 'Loading...' });
    const result = await evaluateOutcome(page, {
      expectAll: [
        { kind: 'urlMatches', pattern: '*dashboard*' },
        { kind: 'textAppears', text: 'Welcome' },
      ],
    });
    expect(result.outcomeStatus).toBe('ambiguous');
    expect(result.retrySafe).toBe(true);
  });

  it('returns success when any expectAny condition matches', async () => {
    const page = createMockPage({ text: 'Success!' });
    const result = await evaluateOutcome(page, {
      expectAny: [
        { kind: 'textAppears', text: 'Success!' },
        { kind: 'textAppears', text: 'Completed' },
      ],
    });
    expect(result.outcomeStatus).toBe('success');
  });

  it('returns ambiguous when no expectAny conditions match', async () => {
    const page = createMockPage({ text: 'Something else' });
    const result = await evaluateOutcome(page, {
      expectAny: [
        { kind: 'textAppears', text: 'Success!' },
        { kind: 'textAppears', text: 'Completed' },
      ],
    });
    expect(result.outcomeStatus).toBe('ambiguous');
  });

  it('returns unsafe_to_retry for dangerous steps with ambiguous outcome', async () => {
    const page = createMockPage({ text: 'Something else' });
    const result = await evaluateOutcome(page, {
      expectAny: [{ kind: 'textAppears', text: 'Not found' }],
      dangerous: true,
    });
    expect(result.outcomeStatus).toBe('unsafe_to_retry');
    expect(result.retrySafe).toBe(false);
  });

  it('returns retrySafe false for dangerous failed steps', async () => {
    const page = createMockPage({ url: 'https://example.com/error' });
    const result = await evaluateOutcome(page, {
      failIf: [{ kind: 'urlMatches', pattern: '*error*' }],
      dangerous: true,
    });
    expect(result.outcomeStatus).toBe('failed');
    expect(result.retrySafe).toBe(false);
  });

  it('returns success with empty condition arrays', async () => {
    const page = createMockPage();
    const result = await evaluateOutcome(page, {
      expectAny: [],
      expectAll: [],
      failIf: [],
    });
    expect(result.outcomeStatus).toBe('success');
    expect(result.matchedConditions).toEqual([]);
  });

  it('collects all matched conditions for reporting', async () => {
    const page = createMockPage({ text: 'Hello World' });
    const result = await evaluateOutcome(page, {
      expectAll: [
        { kind: 'textAppears', text: 'Hello' },
        { kind: 'textAppears', text: 'World' },
      ],
    });
    expect(result.matchedConditions.length).toBe(2);
    expect(result.matchedConditions.every((m) => m.matched)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NetworkResponseTracker
// ---------------------------------------------------------------------------

describe('NetworkResponseTracker', () => {
  it('starts with empty responses', () => {
    const tracker = new NetworkResponseTracker();
    expect(tracker.getResponses()).toEqual([]);
  });

  it('tracks responses when started', () => {
    const tracker = new NetworkResponseTracker();
    let handler: ((...args: unknown[]) => void) | null = null;
    const mockCdp = {
      on: (_event: string, h: (...args: unknown[]) => void) => {
        handler = h;
      },
      off: () => {},
    } as unknown as CDPClient;

    tracker.start(mockCdp);
    expect(handler).not.toBeNull();

    // Simulate a network response event
    handler!({ response: { url: 'https://api.example.com/data', status: 200 } });
    expect(tracker.getResponses()).toEqual([{ url: 'https://api.example.com/data', status: 200 }]);
  });

  it('stops listening and cleans up', () => {
    const tracker = new NetworkResponseTracker();
    let offCalled = false;
    const mockCdp = {
      on: () => {},
      off: () => {
        offCalled = true;
      },
    } as unknown as CDPClient;

    tracker.start(mockCdp);
    tracker.stop(mockCdp);
    expect(offCalled).toBe(true);
  });

  it('resets collected responses', () => {
    const tracker = new NetworkResponseTracker();
    (tracker as unknown as { responses: Array<{ url: string; status: number }> }).responses = [
      { url: 'http://a.com', status: 200 },
    ];
    expect(tracker.getResponses().length).toBe(1);
    tracker.reset();
    expect(tracker.getResponses()).toEqual([]);
  });

  it('does not double-register when start is called twice', () => {
    const tracker = new NetworkResponseTracker();
    let onCallCount = 0;
    const mockCdp = {
      on: () => {
        onCallCount++;
      },
      off: () => {},
    } as unknown as CDPClient;

    tracker.start(mockCdp);
    tracker.start(mockCdp);
    expect(onCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// captureStateSignature
// ---------------------------------------------------------------------------

describe('captureStateSignature', () => {
  it('returns a non-empty string for a valid page', async () => {
    const page = createMockPage({ url: 'https://example.com', text: 'Hello' });
    const sig = await captureStateSignature(page);
    expect(sig.length).toBeGreaterThan(0);
    expect(sig).toContain('https://example.com');
  });

  it('returns identical signatures for identical page state', async () => {
    const page = createMockPage({ url: 'https://example.com', text: 'Same content' });
    const sig1 = await captureStateSignature(page);
    const sig2 = await captureStateSignature(page);
    expect(sig1).toBe(sig2);
  });

  it('returns different signatures for different URLs', async () => {
    const page1 = createMockPage({ url: 'https://a.com', text: 'Same' });
    const page2 = createMockPage({ url: 'https://b.com', text: 'Same' });
    const sig1 = await captureStateSignature(page1);
    const sig2 = await captureStateSignature(page2);
    expect(sig1).not.toBe(sig2);
  });

  it('returns different signatures for different text content', async () => {
    const page1 = createMockPage({ url: 'https://example.com', text: 'Content A' });
    const page2 = createMockPage({ url: 'https://example.com', text: 'Content B' });
    const sig1 = await captureStateSignature(page1);
    const sig2 = await captureStateSignature(page2);
    expect(sig1).not.toBe(sig2);
  });

  it('returns empty string when page methods throw', async () => {
    const page = {
      url: async () => {
        throw new Error('detached');
      },
      text: async () => {
        throw new Error('detached');
      },
    } as unknown as Page;
    const sig = await captureStateSignature(page);
    expect(sig).toBe('');
  });
});
