import { describe, expect, it, mock } from 'bun:test';

// Mock CDP client factory
function createMockCDPClient(evaluateResult: unknown, callFunctionResult?: unknown) {
  return {
    send: mock((method: string, _params?: Record<string, unknown>) => {
      if (method === 'Runtime.evaluate') {
        return Promise.resolve({ result: { value: evaluateResult } });
      }
      if (method === 'DOM.resolveNode') {
        return Promise.resolve({ object: { objectId: 'test-object-id' } });
      }
      if (method === 'Runtime.callFunctionOn') {
        return Promise.resolve({ result: { value: callFunctionResult ?? evaluateResult } });
      }
      return Promise.resolve({});
    }),
    on: mock(() => {}),
    off: mock(() => {}),
    onAny: mock(() => {}),
    close: mock(() => Promise.resolve()),
    attachToTarget: mock(() => Promise.resolve('session-id')),
    sessionId: 'test-session',
    isConnected: true,
  };
}

describe('visibility utilities', () => {
  describe('getVisibilityStateBySelector', () => {
    it('returns visibility state for visible element', async () => {
      const { getVisibilityStateBySelector } = await import('../../src/browser/visibility.ts');

      const mockState = {
        visible: true,
        display: 'block',
        visibility: 'visible',
        opacity: 1,
        width: 100,
        height: 50,
        inViewport: true,
        reasons: [],
      };

      const cdp = createMockCDPClient(mockState);
      const result = await getVisibilityStateBySelector(cdp as never, '#test-element');

      expect(result).not.toBeNull();
      expect(result?.visible).toBe(true);
      expect(result?.display).toBe('block');
      expect(result?.reasons).toEqual([]);
    });

    it('returns reasons for hidden element (display:none)', async () => {
      const { getVisibilityStateBySelector } = await import('../../src/browser/visibility.ts');

      const mockState = {
        visible: false,
        display: 'none',
        visibility: 'visible',
        opacity: 1,
        width: 0,
        height: 0,
        inViewport: false,
        reasons: ['display: none'],
      };

      const cdp = createMockCDPClient(mockState);
      const result = await getVisibilityStateBySelector(cdp as never, '#hidden-element');

      expect(result).not.toBeNull();
      expect(result?.visible).toBe(false);
      expect(result?.reasons).toContain('display: none');
    });

    it('returns reasons for zero opacity element', async () => {
      const { getVisibilityStateBySelector } = await import('../../src/browser/visibility.ts');

      const mockState = {
        visible: false,
        display: 'block',
        visibility: 'visible',
        opacity: 0,
        width: 100,
        height: 50,
        inViewport: true,
        reasons: ['opacity: 0'],
      };

      const cdp = createMockCDPClient(mockState);
      const result = await getVisibilityStateBySelector(cdp as never, '#transparent-element');

      expect(result).not.toBeNull();
      expect(result?.visible).toBe(false);
      expect(result?.opacity).toBe(0);
      expect(result?.reasons).toContain('opacity: 0');
    });

    it('returns reasons for zero-size element', async () => {
      const { getVisibilityStateBySelector } = await import('../../src/browser/visibility.ts');

      const mockState = {
        visible: false,
        display: 'block',
        visibility: 'visible',
        opacity: 1,
        width: 0,
        height: 0,
        inViewport: true,
        reasons: ['zero dimensions'],
      };

      const cdp = createMockCDPClient(mockState);
      const result = await getVisibilityStateBySelector(cdp as never, '#zero-size-element');

      expect(result).not.toBeNull();
      expect(result?.visible).toBe(false);
      expect(result?.reasons).toContain('zero dimensions');
    });

    it('returns null for non-existent element', async () => {
      const { getVisibilityStateBySelector } = await import('../../src/browser/visibility.ts');

      const cdp = createMockCDPClient(null);
      const result = await getVisibilityStateBySelector(cdp as never, '#nonexistent');

      expect(result).toBeNull();
    });

    it('passes contextId when provided', async () => {
      const { getVisibilityStateBySelector } = await import('../../src/browser/visibility.ts');

      const mockState = {
        visible: true,
        display: 'block',
        visibility: 'visible',
        opacity: 1,
        width: 100,
        height: 50,
        inViewport: true,
        reasons: [],
      };

      const cdp = createMockCDPClient(mockState);
      await getVisibilityStateBySelector(cdp as never, '#test', 123);

      expect(cdp.send).toHaveBeenCalledWith(
        'Runtime.evaluate',
        expect.objectContaining({
          contextId: 123,
        })
      );
    });
  });

  describe('getVisibilityState (by nodeId)', () => {
    it('resolves node and returns visibility state', async () => {
      const { getVisibilityState } = await import('../../src/browser/visibility.ts');

      const mockState = {
        visible: true,
        display: 'block',
        visibility: 'visible',
        opacity: 1,
        width: 100,
        height: 50,
        inViewport: true,
        reasons: [],
      };

      const cdp = createMockCDPClient(null, mockState);
      const result = await getVisibilityState(cdp as never, 123);

      expect(result).not.toBeNull();
      expect(result?.visible).toBe(true);
    });

    it('returns null when node cannot be resolved', async () => {
      const { getVisibilityState } = await import('../../src/browser/visibility.ts');

      const cdp = {
        send: mock((method: string) => {
          if (method === 'DOM.resolveNode') {
            return Promise.resolve({ object: null });
          }
          return Promise.resolve({});
        }),
      };

      const result = await getVisibilityState(cdp as never, 999);
      expect(result).toBeNull();
    });
  });

  describe('detectCoveringElementBySelector', () => {
    it('returns null when element is not covered', async () => {
      const { detectCoveringElementBySelector } = await import('../../src/browser/visibility.ts');

      const cdp = createMockCDPClient({ covered: false });
      const result = await detectCoveringElementBySelector(cdp as never, '#uncovered-button');

      expect(result).toBeNull();
    });

    it('returns covering element info when element is covered', async () => {
      const { detectCoveringElementBySelector } = await import('../../src/browser/visibility.ts');

      const mockResult = {
        covered: true,
        coveringElement: {
          tagName: 'div',
          id: 'modal',
          className: 'overlay',
          zIndex: 1000,
        },
      };

      const cdp = createMockCDPClient(mockResult);
      const result = await detectCoveringElementBySelector(cdp as never, '#covered-button');

      expect(result).not.toBeNull();
      expect(result?.tagName).toBe('div');
      expect(result?.id).toBe('modal');
      expect(result?.className).toBe('overlay');
      expect(result?.zIndex).toBe(1000);
    });

    it('returns null when element not found', async () => {
      const { detectCoveringElementBySelector } = await import('../../src/browser/visibility.ts');

      const cdp = createMockCDPClient({ error: 'Element not found' });
      const result = await detectCoveringElementBySelector(cdp as never, '#nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('detectCoveringElement (by nodeId)', () => {
    it('returns covering element when covered', async () => {
      const { detectCoveringElement } = await import('../../src/browser/visibility.ts');

      const mockResult = {
        covered: true,
        coveringElement: {
          tagName: 'div',
          id: 'overlay',
        },
      };

      const cdp = createMockCDPClient(null, mockResult);
      const result = await detectCoveringElement(cdp as never, 123);

      expect(result).not.toBeNull();
      expect(result?.tagName).toBe('div');
    });

    it('returns null when not covered', async () => {
      const { detectCoveringElement } = await import('../../src/browser/visibility.ts');

      const cdp = createMockCDPClient(null, { covered: false });
      const result = await detectCoveringElement(cdp as never, 123);

      expect(result).toBeNull();
    });
  });
});
