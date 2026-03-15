import { describe, expect, it } from 'bun:test';
import {
  generateSelectorStrings,
  generateSelectors,
} from '../../src/browser/selector-generator.ts';
import type { InteractiveElement } from '../../src/browser/types.ts';

describe('generateSelectors', () => {
  it('always includes ref selector as first item', () => {
    const element: InteractiveElement = {
      ref: 'e1',
      role: 'button',
      name: 'Submit',
      selector: '#submit-btn',
    };

    const selectors = generateSelectors(element);
    expect(selectors.length).toBeGreaterThan(0);
    expect(selectors[0]?.selector).toBe('ref:e1');
    expect(selectors[0]?.type).toBe('ref');
  });

  it('includes data-testid selector when present', () => {
    const element: InteractiveElement = {
      ref: 'e2',
      role: 'button',
      name: 'Login',
      selector: '[data-testid="login-button"]',
    };

    const selectors = generateSelectors(element);
    const testidSelector = selectors.find((s) => s.type === 'testid');
    expect(testidSelector).toBeDefined();
    expect(testidSelector?.selector).toBe('[data-testid="login-button"]');
  });

  it('includes aria-label selector when element has name', () => {
    const element: InteractiveElement = {
      ref: 'e3',
      role: 'link',
      name: 'Click Here',
      selector: 'a.some-link',
    };

    const selectors = generateSelectors(element);
    const ariaSelector = selectors.find((s) => s.type === 'aria-label');
    expect(ariaSelector).toBeDefined();
    expect(ariaSelector?.selector).toBe('[aria-label="Click Here"]');
  });

  it('includes id selector when element has id', () => {
    const element: InteractiveElement = {
      ref: 'e4',
      role: 'textbox',
      name: 'Email',
      selector: '#email-input',
    };

    const selectors = generateSelectors(element);
    const idSelector = selectors.find((s) => s.type === 'id');
    expect(idSelector).toBeDefined();
    expect(idSelector?.selector).toBe('#email-input');
  });

  it('includes role-name selector for semantic elements', () => {
    const element: InteractiveElement = {
      ref: 'e5',
      role: 'button',
      name: 'Submit Form',
      selector: 'button.submit',
    };

    const selectors = generateSelectors(element);
    const roleSelector = selectors.find((s) => s.type === 'role-name');
    expect(roleSelector).toBeDefined();
    expect(roleSelector?.selector).toBe('[role="button"][aria-label="Submit Form"]');
  });

  it('includes css fallback', () => {
    const element: InteractiveElement = {
      ref: 'e6',
      role: 'button',
      name: '',
      selector: 'form > button.primary',
    };

    const selectors = generateSelectors(element);
    const cssSelector = selectors.find((s) => s.type === 'css');
    expect(cssSelector).toBeDefined();
  });

  it('handles data-test-id variant', () => {
    const element: InteractiveElement = {
      ref: 'e7',
      role: 'button',
      name: 'Save',
      selector: '[data-test-id="save-btn"]',
    };

    const selectors = generateSelectors(element);
    const testidSelector = selectors.find((s) => s.type === 'testid');
    expect(testidSelector).toBeDefined();
    expect(testidSelector?.selector).toBe('[data-testid="save-btn"]');
  });

  it('handles data-test variant', () => {
    const element: InteractiveElement = {
      ref: 'e8',
      role: 'button',
      name: 'Cancel',
      selector: '[data-test="cancel-btn"]',
    };

    const selectors = generateSelectors(element);
    const testidSelector = selectors.find((s) => s.type === 'testid');
    expect(testidSelector).toBeDefined();
    expect(testidSelector?.selector).toBe('[data-testid="cancel-btn"]');
  });

  it('escapes special characters in attribute values', () => {
    const element: InteractiveElement = {
      ref: 'e9',
      role: 'button',
      name: "Don't click me",
      selector: '#special-btn',
    };

    const selectors = generateSelectors(element);
    const ariaSelector = selectors.find((s) => s.type === 'aria-label');
    expect(ariaSelector).toBeDefined();
    expect(ariaSelector?.selector).toBe('[aria-label="Don\\\'t click me"]');
  });

  it('maintains priority order: ref > testid > aria-label > id > role-name > css', () => {
    const element: InteractiveElement = {
      ref: 'e10',
      role: 'button',
      name: 'Click',
      selector: '#btn[data-testid="test-btn"]',
    };

    const selectors = generateSelectors(element);
    const types = selectors.map((s) => s.type);

    // Check order - earlier types should come before later types
    const refIndex = types.indexOf('ref');
    const testidIndex = types.indexOf('testid');
    const ariaIndex = types.indexOf('aria-label');
    const idIndex = types.indexOf('id');
    const roleIndex = types.indexOf('role-name');

    expect(refIndex).toBeLessThan(testidIndex);
    expect(testidIndex).toBeLessThan(ariaIndex);
    expect(ariaIndex).toBeLessThan(idIndex);
    expect(idIndex).toBeLessThan(roleIndex);
  });

  it('does not include role-name selector when element has no name', () => {
    const element: InteractiveElement = {
      ref: 'e11',
      role: 'button',
      name: '',
      selector: 'button.anon',
    };

    const selectors = generateSelectors(element);
    const roleSelector = selectors.find((s) => s.type === 'role-name');
    expect(roleSelector).toBeUndefined();
  });
});

describe('generateSelectorStrings', () => {
  it('returns just the selector strings', () => {
    const element: InteractiveElement = {
      ref: 'e1',
      role: 'button',
      name: 'Click',
      selector: '#btn',
    };

    const strings = generateSelectorStrings(element);
    expect(Array.isArray(strings)).toBe(true);
    expect(strings[0]).toBe('ref:e1');
    expect(strings.every((s) => typeof s === 'string')).toBe(true);
  });
});
