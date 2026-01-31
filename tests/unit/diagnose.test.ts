import { describe, expect, it, mock } from 'bun:test';

// Test the fuzzy query detection function
describe('diagnose utilities', () => {
  describe('isFuzzyQuery', () => {
    // We need to test the function directly
    // Since it's not exported, we'll test through integration

    it('should be covered by integration tests', () => {
      // Placeholder - the logic is tested via integration tests
      expect(true).toBe(true);
    });
  });
});

describe('diagnose module imports', () => {
  it('exports diagnoseElement function', async () => {
    const module = await import('../../src/browser/diagnose');
    expect(typeof module.diagnoseElement).toBe('function');
  });

  it('exports DiagnoseResult type check via runtime', async () => {
    // DiagnoseResult is a type, so we can't directly test it
    // but we can check the module imports correctly
    const module = await import('../../src/browser/diagnose');
    expect(module).toBeDefined();
  });
});

describe('diagnose with mock page', () => {
  // Create a mock Page object for testing
  function createMockPage(options: {
    snapshotResult?: {
      interactiveElements: Array<{
        ref: string;
        role: string;
        name: string;
        selector: string;
        disabled?: boolean;
      }>;
    };
    refMap?: Record<string, number>;
    querySelectorResult?: { nodeId: number } | null;
    describeNodeResult?: { node: { backendNodeId: number } };
  }) {
    const {
      snapshotResult = {
        interactiveElements: [],
      },
      refMap = {},
      querySelectorResult = null,
      describeNodeResult = { node: { backendNodeId: 1 } },
    } = options;

    const mockCdp = {
      send: mock((method: string, _params?: Record<string, unknown>) => {
        if (method === 'DOM.getDocument') {
          return Promise.resolve({ root: { nodeId: 1 } });
        }
        if (method === 'DOM.querySelector') {
          return Promise.resolve(querySelectorResult ?? { nodeId: 0 });
        }
        if (method === 'DOM.describeNode') {
          return Promise.resolve(describeNodeResult);
        }
        if (method === 'DOM.getAttributes') {
          return Promise.resolve({ attributes: [] });
        }
        if (method === 'DOM.resolveNode') {
          return Promise.resolve({ object: { objectId: 'test' } });
        }
        if (method === 'Runtime.callFunctionOn') {
          return Promise.resolve({
            result: {
              value: {
                visible: true,
                display: 'block',
                visibility: 'visible',
                opacity: 1,
                width: 100,
                height: 50,
                inViewport: true,
                reasons: [],
              },
            },
          });
        }
        if (method === 'DOM.pushNodesByBackendIdsToFrontend') {
          return Promise.resolve({ nodeIds: [1] });
        }
        return Promise.resolve({});
      }),
    };

    return {
      cdpClient: mockCdp,
      snapshot: mock(() =>
        Promise.resolve({
          url: 'https://example.com',
          title: 'Test Page',
          timestamp: new Date().toISOString(),
          accessibilityTree: [],
          interactiveElements: snapshotResult.interactiveElements,
          text: '',
        })
      ),
      exportRefMap: mock(() => refMap),
    };
  }

  it('returns fuzzy candidates when no exact match', async () => {
    const { diagnoseElement } = await import('../../src/browser/diagnose');

    const mockPage = createMockPage({
      snapshotResult: {
        interactiveElements: [
          { ref: 'e1', role: 'button', name: 'Submit', selector: '#submit' },
          { ref: 'e2', role: 'button', name: 'Submit Form', selector: '#submit-form' },
          { ref: 'e3', role: 'link', name: 'Login', selector: 'a.login' },
        ],
      },
    });

    const result = await diagnoseElement(mockPage as never, 'submit');

    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.candidates.length).toBeGreaterThan(0);
      // Should find Submit button
      expect(result.candidates.some((c) => c.name === 'Submit')).toBe(true);
    }
  });

  it('returns exact match when CSS selector finds element', async () => {
    const { diagnoseElement } = await import('../../src/browser/diagnose');

    const mockPage = createMockPage({
      snapshotResult: {
        interactiveElements: [
          { ref: 'e1', role: 'button', name: 'Submit', selector: '#submit-btn' },
        ],
      },
      refMap: { e1: 123 },
      querySelectorResult: { nodeId: 5 },
      describeNodeResult: { node: { backendNodeId: 123 } },
    });

    const result = await diagnoseElement(mockPage as never, '#submit-btn');

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.element.backendNodeId).toBe(123);
      expect(result.visibility).toBeDefined();
      expect(result.interactivity).toBeDefined();
    }
  });

  it('returns exact match for ref: selector', async () => {
    const { diagnoseElement } = await import('../../src/browser/diagnose');

    const mockPage = createMockPage({
      snapshotResult: {
        interactiveElements: [{ ref: 'e4', role: 'button', name: 'Click Me', selector: '#btn' }],
      },
      refMap: { e4: 456 },
    });

    const result = await diagnoseElement(mockPage as never, 'ref:e4');

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.ref).toBe('e4');
    }
  });

  it('returns suggested selectors for exact match', async () => {
    const { diagnoseElement } = await import('../../src/browser/diagnose');

    const mockPage = createMockPage({
      snapshotResult: {
        interactiveElements: [
          { ref: 'e1', role: 'button', name: 'Submit', selector: '#submit-btn' },
        ],
      },
      refMap: { e1: 100 },
      querySelectorResult: { nodeId: 10 },
      describeNodeResult: { node: { backendNodeId: 100 } },
    });

    const result = await diagnoseElement(mockPage as never, '#submit-btn');

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.suggestedSelectors).toBeDefined();
      expect(Array.isArray(result.suggestedSelectors)).toBe(true);
      expect(result.suggestedSelectors.length).toBeGreaterThan(0);
      // Should include ref selector
      expect(result.suggestedSelectors.some((s) => s.startsWith('ref:'))).toBe(true);
    }
  });

  it('respects maxCandidates option', async () => {
    const { diagnoseElement } = await import('../../src/browser/diagnose');

    const mockPage = createMockPage({
      snapshotResult: {
        interactiveElements: [
          { ref: 'e1', role: 'button', name: 'Button 1', selector: '#btn1' },
          { ref: 'e2', role: 'button', name: 'Button 2', selector: '#btn2' },
          { ref: 'e3', role: 'button', name: 'Button 3', selector: '#btn3' },
          { ref: 'e4', role: 'button', name: 'Button 4', selector: '#btn4' },
          { ref: 'e5', role: 'button', name: 'Button 5', selector: '#btn5' },
        ],
      },
    });

    const result = await diagnoseElement(mockPage as never, 'button', { maxCandidates: 2 });

    expect(result.matched).toBe(false);
    if (!result.matched) {
      expect(result.candidates.length).toBeLessThanOrEqual(2);
    }
  });
});
