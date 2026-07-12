/**
 * Behavioral fitness tests for dangerous and uncertain retry policy.
 */
import { expect, test } from 'bun:test';
import { shouldRetry } from '../../src/actions/conditions.ts';

test('dangerous dispatched actions are never retried', () => {
  const decision = shouldRetry({
    effect: 'at_most_once',
    dangerous: true,
    dispatchState: 'dispatched',
    retrySafe: false,
    attempt: 0,
    maxAttempts: 3,
  });

  expect(decision).toEqual({ retry: false, reason: 'retry_unsafe' });
});

test('uncertain non-dangerous actions are never redispatched', () => {
  const decision = shouldRetry({
    effect: 'at_most_once',
    dangerous: false,
    dispatchState: 'uncertain',
    retrySafe: true,
    attempt: 0,
    maxAttempts: 3,
  });

  expect(decision).toEqual({ retry: false, reason: 'dispatch_already_attempted' });
});

test('dangerous actions may retry only with a proven pre-dispatch failure', () => {
  const decision = shouldRetry({
    effect: 'at_most_once',
    dangerous: true,
    dispatchState: 'not_dispatched',
    retrySafe: true,
    attempt: 0,
    maxAttempts: 2,
  });

  expect(decision).toEqual({ retry: true, reason: 'retry_allowed_pre_dispatch' });
});
