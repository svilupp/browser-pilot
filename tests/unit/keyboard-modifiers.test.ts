/**
 * Unit tests for keyboard modifier support
 */

import { describe, expect, test } from 'bun:test';
import { BatchExecutor } from '../../src/actions/executor.ts';
import { validateSteps } from '../../src/actions/validate.ts';
import {
  computeModifierBitmask,
  MODIFIER_CODES,
  MODIFIER_KEY_CODES,
  parseShortcut,
} from '../../src/browser/keyboard.ts';
import type { Page } from '../../src/browser/page.ts';

// --- computeModifierBitmask tests ---

describe('computeModifierBitmask', () => {
  test('returns 0 for empty array', () => {
    expect(computeModifierBitmask([])).toBe(0);
  });

  test('returns 1 for Alt', () => {
    expect(computeModifierBitmask(['Alt'])).toBe(1);
  });

  test('returns 2 for Control', () => {
    expect(computeModifierBitmask(['Control'])).toBe(2);
  });

  test('returns 4 for Meta', () => {
    expect(computeModifierBitmask(['Meta'])).toBe(4);
  });

  test('returns 8 for Shift', () => {
    expect(computeModifierBitmask(['Shift'])).toBe(8);
  });

  test('combines multiple modifiers', () => {
    // Control + Shift = 2 + 8 = 10
    expect(computeModifierBitmask(['Control', 'Shift'])).toBe(10);
  });

  test('combines all modifiers', () => {
    // Alt(1) + Control(2) + Meta(4) + Shift(8) = 15
    expect(computeModifierBitmask(['Alt', 'Control', 'Meta', 'Shift'])).toBe(15);
  });

  test('ignores unknown modifiers', () => {
    expect(computeModifierBitmask(['Control', 'Unknown'])).toBe(2);
  });
});

// --- parseShortcut tests ---

describe('parseShortcut', () => {
  test('parses Control+a', () => {
    const result = parseShortcut('Control+a');
    expect(result.modifiers).toEqual(['Control']);
    expect(result.key).toBe('a');
  });

  test('parses Meta+Shift+z', () => {
    const result = parseShortcut('Meta+Shift+z');
    expect(result.modifiers).toEqual(['Meta', 'Shift']);
    expect(result.key).toBe('z');
  });

  test('parses Control+Shift+Alt+Delete', () => {
    const result = parseShortcut('Control+Shift+Alt+Delete');
    expect(result.modifiers).toEqual(['Control', 'Shift', 'Alt']);
    expect(result.key).toBe('Delete');
  });

  test('throws for single key without modifier', () => {
    expect(() => parseShortcut('a')).toThrow('must contain at least one modifier');
  });

  test('throws for invalid modifier', () => {
    expect(() => parseShortcut('Super+a')).toThrow('Invalid modifier "Super"');
  });

  test('parses Control+Enter', () => {
    const result = parseShortcut('Control+Enter');
    expect(result.modifiers).toEqual(['Control']);
    expect(result.key).toBe('Enter');
  });
});

// --- MODIFIER_CODES / MODIFIER_KEY_CODES constants ---

describe('modifier constants', () => {
  test('MODIFIER_CODES has all four modifiers', () => {
    expect(MODIFIER_CODES['Control']).toBe('ControlLeft');
    expect(MODIFIER_CODES['Shift']).toBe('ShiftLeft');
    expect(MODIFIER_CODES['Alt']).toBe('AltLeft');
    expect(MODIFIER_CODES['Meta']).toBe('MetaLeft');
  });

  test('MODIFIER_KEY_CODES has correct key codes', () => {
    expect(MODIFIER_KEY_CODES['Control']).toBe(17);
    expect(MODIFIER_KEY_CODES['Shift']).toBe(16);
    expect(MODIFIER_KEY_CODES['Alt']).toBe(18);
    expect(MODIFIER_KEY_CODES['Meta']).toBe(91);
  });
});

// --- Modifier key sequence (integration with mock CDP) ---

describe('press with modifiers dispatches correct sequence', () => {
  function createMockPage() {
    const calls: Array<{ method: string; args: unknown[] }> = [];

    const page = {
      calls,

      async press(
        key: string,
        options?: { modifiers?: Array<'Control' | 'Shift' | 'Alt' | 'Meta'> }
      ) {
        calls.push({ method: 'press', args: [key, options] });
      },

      async shortcut(combo: string) {
        calls.push({ method: 'shortcut', args: [combo] });
      },

      // Required mock methods for BatchExecutor
      async goto() {},
      async click() {
        return true;
      },
      async fill() {
        return true;
      },
      async type() {
        return true;
      },
      async select() {
        return true;
      },
      async check() {
        return true;
      },
      async uncheck() {
        return true;
      },
      async submit() {
        return true;
      },
      async focus() {
        return true;
      },
      async hover() {
        return true;
      },
      async scroll() {
        return true;
      },
      async waitFor() {
        return true;
      },
      async waitForNavigation() {
        return true;
      },
      async waitForNetworkIdle() {
        return true;
      },
      async snapshot() {
        return { url: '', title: '', timestamp: '', tree: '' };
      },
      async screenshot() {
        return '';
      },
      async evaluate() {
        return null;
      },
      async text() {
        return '';
      },
      async url() {
        return '';
      },
      async switchToFrame() {},
      async switchToMain() {},
      getLastMatchedSelector() {
        return undefined;
      },
    };

    return page;
  }

  test('shortcut batch action calls page.shortcut', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);
    const result = await executor.execute([{ action: 'shortcut', combo: 'Control+a' }]);

    expect(result.success).toBe(true);
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]!.method).toBe('shortcut');
    expect(page.calls[0]!.args).toEqual(['Control+a']);
  });

  test('press batch action passes modifiers', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);
    const result = await executor.execute([{ action: 'press', key: 'c', modifiers: ['Control'] }]);

    expect(result.success).toBe(true);
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]!.method).toBe('press');
    expect(page.calls[0]!.args).toEqual(['c', { modifiers: ['Control'] }]);
  });

  test('shortcut batch action fails without combo', async () => {
    const page = createMockPage();
    const executor = new BatchExecutor(page as unknown as Page);
    const result = await executor.execute([{ action: 'shortcut' } as never]);

    expect(result.success).toBe(false);
    expect(result.steps[0]!.error).toContain('shortcut requires combo');
  });
});

// --- Validation tests ---

describe('shortcut step validation', () => {
  test('valid shortcut step passes', () => {
    const result = validateSteps([{ action: 'shortcut', combo: 'Control+a' }]);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('shortcut without combo fails validation', () => {
    const result = validateSteps([{ action: 'shortcut' }]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'combo')).toBe(true);
  });

  test('shortcut with non-string combo fails validation', () => {
    const result = validateSteps([{ action: 'shortcut', combo: 123 }]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'combo')).toBe(true);
  });

  test('press with modifiers passes validation', () => {
    const result = validateSteps([{ action: 'press', key: 'a', modifiers: ['Control'] }]);
    expect(result.valid).toBe(true);
  });

  test('hotkey alias resolves to shortcut', () => {
    const result = validateSteps([{ action: 'hotkey', combo: 'Control+c' }]);
    // Should get a suggestion for the alias
    expect(result.errors.some((e) => e.message.includes('shortcut'))).toBe(true);
  });

  test('combo is recognized as known field', () => {
    const result = validateSteps([{ action: 'shortcut', combo: 'Control+a' }]);
    // No "unknown property" errors for combo
    expect(result.errors.filter((e) => e.message.includes('unknown property'))).toHaveLength(0);
  });

  test('modifiers is recognized as known field', () => {
    const result = validateSteps([{ action: 'press', key: 'a', modifiers: ['Control'] }]);
    expect(result.errors.filter((e) => e.message.includes('unknown property'))).toHaveLength(0);
  });
});
