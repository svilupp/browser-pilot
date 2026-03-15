import { describe, expect, it, mock } from 'bun:test';
import { chooseOption } from '../../src/browser/combobox.ts';
import type { Page } from '../../src/browser/page.ts';

function createMockPage(
  overrides: {
    clickFails?: boolean;
    waitForResult?: boolean;
    evaluateResult?: unknown;
    typeFails?: boolean;
  } = {}
): Page {
  const {
    clickFails = false,
    waitForResult = true,
    evaluateResult = null,
    typeFails = false,
  } = overrides;

  return {
    click: mock(async () => {
      if (clickFails) throw new Error('click failed');
    }),
    waitFor: mock(async () => waitForResult),
    type: mock(async () => {
      if (typeFails) throw new Error('type failed');
    }),
    evaluate: mock(async () => evaluateResult),
  } as unknown as Page;
}

describe('chooseOption', () => {
  it('selects an option successfully', async () => {
    const page = createMockPage({ evaluateResult: 'Canada' });

    const result = await chooseOption(page, {
      trigger: '#trigger',
      value: 'Canada',
    });

    expect(result.success).toBe(true);
    expect(result.selectedText).toBe('Canada');
    expect(result.failedAt).toBeUndefined();
    expect(result.error).toBeUndefined();

    // Verify click was called on the trigger
    expect(page.click).toHaveBeenCalledTimes(1);
    // Verify waitFor was called for the listbox
    expect(page.waitFor).toHaveBeenCalledTimes(1);
    // Verify evaluate was called to find and click the option
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it('returns failure when listbox does not appear', async () => {
    const page = createMockPage({ waitForResult: false });

    const result = await chooseOption(page, {
      trigger: '#trigger',
      value: 'Canada',
    });

    expect(result.success).toBe(false);
    expect(result.failedAt).toBe('open');
    expect(result.error).toContain('Listbox did not appear');
  });

  it('returns failure when option is not found', async () => {
    const page = createMockPage({ evaluateResult: null });

    const result = await chooseOption(page, {
      trigger: '#trigger',
      value: 'Nonexistent',
    });

    expect(result.success).toBe(false);
    expect(result.failedAt).toBe('select');
    expect(result.error).toContain('No option matching "Nonexistent" found');
  });

  it('returns failure when search text typing fails', async () => {
    const page = createMockPage({ typeFails: true });

    const result = await chooseOption(page, {
      trigger: '#trigger',
      value: 'Canada',
      searchText: 'can',
    });

    expect(result.success).toBe(false);
    expect(result.failedAt).toBe('search');
    expect(result.error).toContain('Failed to type search text');
  });

  it('catches trigger click error and returns failure', async () => {
    const page = createMockPage({ clickFails: true });

    const result = await chooseOption(page, {
      trigger: '#trigger',
      value: 'Canada',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('click failed');
  });

  it('uses custom listbox and option selectors', async () => {
    const page = createMockPage({ evaluateResult: 'Germany' });

    const result = await chooseOption(page, {
      trigger: '#trigger',
      listbox: '.custom-dropdown',
      optionSelector: '.custom-option',
      value: 'Germany',
      match: 'exact',
    });

    expect(result.success).toBe(true);
    expect(result.selectedText).toBe('Germany');

    // waitFor should have been called with the custom listbox selector
    const waitForCall = (page.waitFor as ReturnType<typeof mock>).mock.calls[0];
    expect(waitForCall?.[0]).toEqual(['.custom-dropdown']);
  });

  it('supports array trigger selectors', async () => {
    const page = createMockPage({ evaluateResult: 'Japan' });

    const result = await chooseOption(page, {
      trigger: ['#trigger-primary', '#trigger-fallback'],
      value: 'Japan',
    });

    expect(result.success).toBe(true);
    // click should have received the array
    const clickCall = (page.click as ReturnType<typeof mock>).mock.calls[0];
    expect(clickCall?.[0]).toEqual(['#trigger-primary', '#trigger-fallback']);
  });
});
