import { describe, expect, it } from 'bun:test';
import { classifyFailure, getSuggestion } from '../../src/actions/executor.ts';
import type { FailureReason } from '../../src/actions/types.ts';
import { ActionabilityError } from '../../src/browser/actionability.ts';
import { ElementNotFoundError, NavigationError, TimeoutError } from '../../src/browser/types.ts';
import { CDPError } from '../../src/cdp/protocol.ts';

describe('classifyFailure', () => {
  it('ElementNotFoundError -> missing', () => {
    const error = new ElementNotFoundError('#nonexistent');
    const result = classifyFailure(error);
    expect(result.reason).toBe('missing');
  });

  it('ActionabilityError visible -> hidden', () => {
    const error = new ActionabilityError('Element not visible', 'visible');
    expect(classifyFailure(error).reason).toBe('hidden');
  });

  it('ActionabilityError hitTarget -> covered with coveringElement', () => {
    const covering = { tag: 'div', id: 'modal', className: 'overlay' };
    const error = new ActionabilityError('Element covered', 'hitTarget', covering);
    const result = classifyFailure(error);
    expect(result.reason).toBe('covered');
    expect(result.coveringElement).toEqual(covering);
  });

  it('ActionabilityError enabled -> disabled', () => {
    const error = new ActionabilityError('Element disabled', 'enabled');
    expect(classifyFailure(error).reason).toBe('disabled');
  });

  it('ActionabilityError editable + readonly -> readonly', () => {
    const error = new ActionabilityError('Element is readonly', 'editable');
    expect(classifyFailure(error).reason).toBe('readonly');
  });

  it('ActionabilityError editable without readonly -> notEditable', () => {
    const error = new ActionabilityError('Element not editable', 'editable');
    expect(classifyFailure(error).reason).toBe('notEditable');
  });

  it('ActionabilityError stable -> replaced', () => {
    const error = new ActionabilityError('Element not stable', 'stable');
    expect(classifyFailure(error).reason).toBe('replaced');
  });

  it('TimeoutError -> timeout', () => {
    const error = new TimeoutError('Timed out');
    expect(classifyFailure(error).reason).toBe('timeout');
  });

  it('NavigationError -> navigation', () => {
    const error = new NavigationError('Navigation failed');
    expect(classifyFailure(error).reason).toBe('navigation');
  });

  it('CDPError -> cdpError', () => {
    const error = new CDPError({ code: -32000, message: 'Protocol error' });
    expect(classifyFailure(error).reason).toBe('cdpError');
  });

  it('stale node message -> detached', () => {
    const error = new Error('Could not find node with given id');
    expect(classifyFailure(error).reason).toBe('detached');
  });

  it('stale node "does not belong" message -> detached', () => {
    const error = new Error('Node does not belong to the document');
    expect(classifyFailure(error).reason).toBe('detached');
  });

  it('unknown error -> unknown', () => {
    const error = new Error('Something unexpected happened');
    expect(classifyFailure(error).reason).toBe('unknown');
  });

  it('non-Error value -> unknown', () => {
    expect(classifyFailure('string error').reason).toBe('unknown');
    expect(classifyFailure(null).reason).toBe('unknown');
    expect(classifyFailure(42).reason).toBe('unknown');
  });
});

describe('getSuggestion', () => {
  const allReasons: FailureReason[] = [
    'missing',
    'hidden',
    'covered',
    'disabled',
    'readonly',
    'detached',
    'replaced',
    'notEditable',
    'timeout',
    'navigation',
    'cdpError',
    'unknown',
  ];

  it('every FailureReason has a non-empty suggestion', () => {
    for (const reason of allReasons) {
      const suggestion = getSuggestion(reason);
      expect(suggestion).toBeTruthy();
      expect(typeof suggestion).toBe('string');
      expect(suggestion.length).toBeGreaterThan(10);
    }
  });

  it('missing suggests snapshot', () => {
    expect(getSuggestion('missing')).toContain('snapshot');
  });

  it('covered suggests dismissing overlay', () => {
    expect(getSuggestion('covered')).toContain('covering element');
  });

  it('disabled suggests prerequisite', () => {
    expect(getSuggestion('disabled')).toContain('prerequisite');
  });

  it('detached suggests fresh snapshot', () => {
    expect(getSuggestion('detached')).toContain('snapshot');
  });

  it('cdpError suggests bp connect', () => {
    expect(getSuggestion('cdpError')).toContain('bp connect');
  });
});
