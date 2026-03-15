import { describe, expect, it } from 'bun:test';
import type { Page } from '../../src/browser/page.ts';
import { submitAndVerify } from '../../src/browser/safe-submit.ts';

function createMockPage(
  options: { url?: string; text?: string; waitForResult?: boolean; submitThrows?: boolean } = {}
) {
  const {
    url = 'http://example.com',
    text = 'Success',
    waitForResult = true,
    submitThrows = false,
  } = options;
  return {
    url: async () => url,
    text: async (_sel?: string) => text,
    title: async () => 'Test',
    waitFor: async (_sel: string, _opts?: Record<string, unknown>) => waitForResult,
    submit: async (_sel: string | string[], _opts?: Record<string, unknown>) => {
      if (submitThrows) throw new Error('Submit failed');
      return true;
    },
    cdpClient: {
      on: (_event: string, _handler: (...args: unknown[]) => void) => {},
      off: (_event: string, _handler: (...args: unknown[]) => void) => {},
    },
  } as unknown as Page;
}

describe('submitAndVerify', () => {
  it('returns success with expectAny condition met', async () => {
    const page = createMockPage({ url: 'http://example.com/thanks', text: 'Thank you' });

    const result = await submitAndVerify(page, {
      selector: 'form',
      expectAny: [{ kind: 'urlMatches', pattern: '*thanks*' }],
    });

    expect(result.submitted).toBe(true);
    expect(result.outcomeStatus).toBe('success');
    expect(result.matchedConditions.length).toBeGreaterThan(0);
    expect(result.retrySafe).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns error when submit fails mechanically', async () => {
    const page = createMockPage({ submitThrows: true });

    const result = await submitAndVerify(page, {
      selector: 'form',
      expectAny: [{ kind: 'urlMatches', pattern: '*thanks*' }],
    });

    expect(result.submitted).toBe(false);
    expect(result.outcomeStatus).toBe('failed');
    expect(result.error).toBe('Submit failed');
    expect(result.retrySafe).toBe(true);
  });

  it('sets retrySafe to false when dangerous flag is set and submit fails', async () => {
    const page = createMockPage({ submitThrows: true });

    const result = await submitAndVerify(page, {
      selector: 'form',
      dangerous: true,
    });

    expect(result.submitted).toBe(false);
    expect(result.retrySafe).toBe(false);
  });

  it('returns success with no conditions', async () => {
    const page = createMockPage();

    const result = await submitAndVerify(page, {
      selector: 'form',
    });

    expect(result.submitted).toBe(true);
    expect(result.outcomeStatus).toBe('success');
    expect(result.matchedConditions).toHaveLength(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns failed when failIf condition matches', async () => {
    const page = createMockPage({ text: 'Error: invalid email' });

    const result = await submitAndVerify(page, {
      selector: 'form',
      failIf: [{ kind: 'textAppears', text: 'Error:' }],
    });

    expect(result.submitted).toBe(true);
    expect(result.outcomeStatus).toBe('failed');
    expect(result.retrySafe).toBe(true);
  });

  it('returns failed with retrySafe false when dangerous and failIf matches', async () => {
    const page = createMockPage({ text: 'Error: payment declined' });

    const result = await submitAndVerify(page, {
      selector: 'form',
      dangerous: true,
      failIf: [{ kind: 'textAppears', text: 'Error:' }],
    });

    expect(result.submitted).toBe(true);
    expect(result.outcomeStatus).toBe('failed');
    expect(result.retrySafe).toBe(false);
  });

  it('tracks durationMs', async () => {
    const page = createMockPage();

    const result = await submitAndVerify(page, { selector: 'form' });

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe('number');
  });
});
