import { expect, test } from 'bun:test';
import { ActionDispatch } from '../../src/browser/action-dispatch.ts';
import { decodeRuntimeResult, RuntimeResultError } from '../../src/cdp/runtime-result.ts';

test('Runtime results distinguish valid undefined, malformed shape, and renderer exceptions', () => {
  expect(decodeRuntimeResult({ result: { type: 'undefined' } })).toEqual({ type: 'undefined' });
  for (const value of [
    undefined,
    {},
    { result: null },
    { result: 'wrong' },
    { result: {} },
    { result: { type: 'number', value: 'wrong' } },
    { exceptionDetails: 'wrong' },
    { exceptionDetails: null, result: { type: 'undefined' } },
  ]) {
    expect(() => decodeRuntimeResult(value)).toThrow('Runtime result');
  }
  const details = { text: 'Renderer unavailable', exceptionId: 7, lineNumber: 0, columnNumber: 0 };
  try {
    decodeRuntimeResult({ exceptionDetails: details });
    throw new Error('expected renderer exception');
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeResultError);
    expect((error as RuntimeResultError).code).toBe('RUNTIME_EXCEPTION');
    expect((error as RuntimeResultError).exceptionDetails).toBe(details);
  }
});

test('input failure before dispatch stays retryable; ambiguous dispatched failure does not', async () => {
  const before = new ActionDispatch();
  await expect(
    before.send(async () => {
      throw Object.assign(new Error('deadline'), { dispatchState: 'not_dispatched' });
    }, 'Input.insertText')
  ).rejects.toThrow('deadline');
  expect(before.toReceipt().dispatchState).toBe('not_dispatched');
  expect(before.canRetryAction).toBe(true);
  const after = new ActionDispatch();
  await expect(
    after.send(async () => {
      throw Object.assign(new Error('timeout'), { dispatchState: 'unknown' });
    }, 'Input.insertText')
  ).rejects.toThrow('timeout');
  expect(after.toReceipt().dispatchState).toBe('uncertain');
  expect(after.canRetryAction).toBe(false);
});
