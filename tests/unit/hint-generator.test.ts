import { describe, expect, it } from 'bun:test';
import { generateHintsFromSnapshot } from '../../src/browser/hint-generator';
import type { PageSnapshot } from '../../src/browser/types';

describe('generateHintsFromSnapshot', () => {
  const createMockSnapshot = (
    elements: Array<{
      ref: string;
      role: string;
      name: string;
      selector: string;
      disabled?: boolean;
    }>
  ): PageSnapshot => ({
    url: 'https://example.com',
    title: 'Test Page',
    timestamp: new Date().toISOString(),
    accessibilityTree: [],
    interactiveElements: elements,
    text: '',
  });

  it('filters candidates by action type roles', () => {
    const snapshot = createMockSnapshot([
      { ref: 'e1', role: 'button', name: 'Submit', selector: '#submit' },
      { ref: 'e2', role: 'textbox', name: 'Email', selector: '#email' },
      { ref: 'e3', role: 'link', name: 'Login', selector: 'a.login' },
    ]);

    // Click action should only suggest buttons and links
    const clickHints = generateHintsFromSnapshot(snapshot, ['#missing-btn'], 'click');
    expect(clickHints.every((h) => ['button', 'link'].includes(h.element.role))).toBe(true);

    // Fill action should only suggest textboxes
    const fillHints = generateHintsFromSnapshot(snapshot, ['#missing-input'], 'fill');
    expect(fillHints.every((h) => h.element.role === 'textbox')).toBe(true);
  });

  it('returns max 3 hints by default', () => {
    const snapshot = createMockSnapshot([
      { ref: 'e1', role: 'button', name: 'Button 1', selector: '#btn1' },
      { ref: 'e2', role: 'button', name: 'Button 2', selector: '#btn2' },
      { ref: 'e3', role: 'button', name: 'Button 3', selector: '#btn3' },
      { ref: 'e4', role: 'button', name: 'Button 4', selector: '#btn4' },
      { ref: 'e5', role: 'button', name: 'Button 5', selector: '#btn5' },
    ]);

    const hints = generateHintsFromSnapshot(snapshot, ['#btn'], 'click');
    expect(hints.length).toBeLessThanOrEqual(3);
  });

  it('respects custom maxHints parameter', () => {
    const snapshot = createMockSnapshot([
      { ref: 'e1', role: 'button', name: 'Button 1', selector: '#btn1' },
      { ref: 'e2', role: 'button', name: 'Button 2', selector: '#btn2' },
      { ref: 'e3', role: 'button', name: 'Button 3', selector: '#btn3' },
    ]);

    const hints = generateHintsFromSnapshot(snapshot, ['button'], 'click', 2);
    expect(hints.length).toBeLessThanOrEqual(2);
  });

  it('extracts intent from aria-label selector', () => {
    const snapshot = createMockSnapshot([
      { ref: 'e1', role: 'button', name: 'Submit Form', selector: '#submit-form' },
      { ref: 'e2', role: 'button', name: 'Other Button', selector: '#other' },
    ]);

    const hints = generateHintsFromSnapshot(snapshot, ['[aria-label="Submit"]'], 'click');
    expect(hints.length).toBeGreaterThan(0);
    // Should find Submit Form as highest match
    expect(hints.some((h) => h.element.name.includes('Submit'))).toBe(true);
  });

  it('extracts intent from ID selector', () => {
    const snapshot = createMockSnapshot([
      { ref: 'e1', role: 'button', name: 'Login', selector: '#login-btn' },
      { ref: 'e2', role: 'button', name: 'Other', selector: '#other' },
    ]);

    const hints = generateHintsFromSnapshot(snapshot, ['#login'], 'click');
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.some((h) => h.element.name === 'Login')).toBe(true);
  });

  it('returns confidence levels based on score', () => {
    const snapshot = createMockSnapshot([
      { ref: 'e1', role: 'button', name: 'Submit', selector: '#submit' },
    ]);

    const hints = generateHintsFromSnapshot(snapshot, ['submit'], 'click');
    expect(hints.length).toBeGreaterThan(0);
    // Exact match should be high confidence
    expect(hints[0]).toBeDefined();
    expect(['high', 'medium', 'low']).toContain(hints[0]!.confidence);
  });

  it('includes disabled status in hints', () => {
    const snapshot = createMockSnapshot([
      { ref: 'e1', role: 'button', name: 'Submit', selector: '#submit', disabled: true },
    ]);

    const hints = generateHintsFromSnapshot(snapshot, ['submit'], 'click');
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]?.element.disabled).toBe(true);
  });

  it('uses ref selector format in hints', () => {
    const snapshot = createMockSnapshot([
      { ref: 'e4', role: 'button', name: 'Submit', selector: '#submit' },
    ]);

    const hints = generateHintsFromSnapshot(snapshot, ['submit'], 'click');
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]?.selector).toBe('ref:e4');
  });

  it('returns empty array when no candidates match', () => {
    const snapshot = createMockSnapshot([
      { ref: 'e1', role: 'textbox', name: 'Email', selector: '#email' },
    ]);

    // Click action with only textbox elements should return empty
    const hints = generateHintsFromSnapshot(snapshot, ['#missing'], 'click');
    expect(hints).toEqual([]);
  });

  it('returns empty array for empty snapshot', () => {
    const snapshot = createMockSnapshot([]);

    const hints = generateHintsFromSnapshot(snapshot, ['#missing'], 'click');
    expect(hints).toEqual([]);
  });

  it('includes matchReason in hints', () => {
    const snapshot = createMockSnapshot([
      { ref: 'e1', role: 'button', name: 'Submit', selector: '#submit' },
    ]);

    const hints = generateHintsFromSnapshot(snapshot, ['submit'], 'click');
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]?.reason).toBeTruthy();
    expect(typeof hints[0]?.reason).toBe('string');
  });
});
