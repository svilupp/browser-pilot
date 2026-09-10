/**
 * Unit tests for the manual AbortSignal combiner used instead of
 * `AbortSignal.any` (which requires Node >=20.3; package.json declares
 * `engines.node >= 18`).
 */

import { describe, expect, test } from 'bun:test';
import { combineAbortSignals } from '../../src/just-bash/index.ts';

describe('combineAbortSignals', () => {
  test('is not aborted when no input signal is aborted', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = combineAbortSignals([a.signal, b.signal]);
    expect(combined.aborted).toBe(false);
  });

  test('aborts when any later input signal aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = combineAbortSignals([a.signal, b.signal]);

    b.abort('b-reason');

    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe('b-reason');
  });

  test('is already aborted if any input signal is already aborted', () => {
    const a = new AbortController();
    a.abort('already-gone');
    const b = new AbortController();

    const combined = combineAbortSignals([a.signal, b.signal]);

    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe('already-gone');
  });

  test('does not throw or double-abort when both inputs abort', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = combineAbortSignals([a.signal, b.signal]);

    a.abort('first');
    b.abort('second');

    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe('first');
  });

  test('single signal passthrough behavior', () => {
    const a = new AbortController();
    const combined = combineAbortSignals([a.signal]);
    expect(combined.aborted).toBe(false);
    a.abort('only');
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe('only');
  });
});
