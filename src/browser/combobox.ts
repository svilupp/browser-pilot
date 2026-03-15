/**
 * Custom combobox interaction — handles searchable dropdowns, listboxes
 */

import type { Page } from './page.ts';

export interface ComboboxConfig {
  /** Trigger element (the combobox button/input) */
  trigger: string | string[];
  /** Listbox/options container that appears after opening */
  listbox?: string | string[];
  /** Individual option selector pattern */
  optionSelector?: string;
  /** Text to search/filter by */
  searchText?: string;
  /** Value to select (matched against option text) */
  value: string;
  /** Match mode for option text */
  match?: 'exact' | 'contains' | 'startsWith';
  /** Timeout for each sub-step */
  timeout?: number;
}

export interface ComboboxResult {
  /** Whether the selection succeeded */
  success: boolean;
  /** Which stage failed, if any */
  failedAt?: 'open' | 'search' | 'select' | 'verify';
  /** The option text that was selected */
  selectedText?: string;
  /** Error message */
  error?: string;
}

/**
 * Default listbox selectors to try when none specified
 */
const DEFAULT_LISTBOX_SELECTORS: string[] = [
  '[role="listbox"]',
  '[role="menu"]',
  '[role="tree"]',
  'ul[class*="dropdown"]',
  'ul[class*="option"]',
  'ul[class*="list"]',
  'div[class*="dropdown"]',
  'div[class*="menu"]',
];

/**
 * Default option selectors to try
 */
const DEFAULT_OPTION_SELECTORS: string[] = [
  '[role="option"]',
  '[role="menuitem"]',
  '[role="treeitem"]',
  'li',
];

/**
 * Interact with a custom combobox: open -> optionally search -> select -> verify.
 */
export async function chooseOption(page: Page, config: ComboboxConfig): Promise<ComboboxResult> {
  const {
    trigger,
    listbox,
    optionSelector,
    searchText,
    value,
    match = 'contains',
    timeout = 10000,
  } = config;

  try {
    // Step 1: Open the combobox
    await page.click(trigger, { timeout });

    // Step 2: Wait for listbox to appear
    const listboxSelectors = listbox
      ? Array.isArray(listbox)
        ? listbox
        : [listbox]
      : DEFAULT_LISTBOX_SELECTORS;

    const listboxFound = await page.waitFor(listboxSelectors, {
      timeout: Math.min(timeout, 3000),
      optional: true,
      state: 'visible',
    });

    if (!listboxFound) {
      return {
        success: false,
        failedAt: 'open',
        error: 'Listbox did not appear after clicking trigger',
      };
    }

    // Step 3: Type search text if provided
    if (searchText) {
      try {
        const triggerSel = Array.isArray(trigger) ? trigger[0]! : trigger;
        await page.type(triggerSel, searchText, {
          delay: 30,
          timeout: Math.min(timeout, 3000),
        });
        // Brief wait for filtering
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch {
        return { success: false, failedAt: 'search', error: 'Failed to type search text' };
      }
    }

    // Step 4: Find and click the matching option
    const optionSelectors = optionSelector ? [optionSelector] : DEFAULT_OPTION_SELECTORS;

    const matchFn =
      match === 'exact' ? 'exact' : match === 'startsWith' ? 'startsWith' : 'contains';

    const clickedOption = await page.evaluate(`(() => {
      const selectors = ${JSON.stringify(optionSelectors)};
      const targetValue = ${JSON.stringify(value)};
      const matchMode = ${JSON.stringify(matchFn)};

      for (const sel of selectors) {
        const options = document.querySelectorAll(sel);
        for (const opt of options) {
          const text = (opt.textContent || '').trim();
          let matches = false;
          if (matchMode === 'exact') matches = text === targetValue;
          else if (matchMode === 'startsWith') matches = text.startsWith(targetValue);
          else matches = text.includes(targetValue);

          if (matches) {
            opt.click();
            return text;
          }
        }
      }
      return null;
    })()`);

    if (!clickedOption) {
      return { success: false, failedAt: 'select', error: `No option matching "${value}" found` };
    }

    return {
      success: true,
      selectedText: String(clickedOption),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
