import type { CDPClient } from '../cdp/client.ts';

const OPERATIONS = new Set([
  'click',
  'dblclick',
  'fill',
  'type',
  'select',
  'check',
  'uncheck',
  'press',
  'hover',
  'focus',
  'scroll',
  'drag',
  'upload',
  'submit',
  'goto',
  'reload',
  'goBack',
  'goForward',
  'evaluate',
  'emit',
  'batch',
  'setCookie',
  'setExtraHTTPHeaders',
  'setGeolocation',
  'setPermissions',
  'callTool',
]);

function uncertainReceipt(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const state = (value as { dispatchState?: string }).dispatchState;
  return state === 'unknown' || state === 'uncertain';
}

/** Keep a logical operation admitted across its multiple CDP sends and waits. */
export function withOwnerOperations<T extends object>(page: T, cdp: CDPClient): T {
  return new Proxy(page, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      if (
        typeof key !== 'string' ||
        (!OPERATIONS.has(key) && value.constructor.name !== 'AsyncFunction')
      )
        return value.bind(target);
      return async (...args: unknown[]) => {
        const readReceipt: unknown = Reflect.get(target, 'getLastActionReceipt');
        const previous: unknown =
          typeof readReceipt === 'function' ? Reflect.apply(readReceipt, target, []) : undefined;
        const { operationId } = await cdp.send<{ operationId: string }>(
          'daemon.beginOperation',
          undefined,
          null
        );
        let uncertain = false;
        try {
          const result: unknown = await Reflect.apply(value, target, args);
          // Batch receipts belong to the library; arbitrary evaluate results are page data.
          if (key === 'batch' && result && typeof result === 'object') {
            const steps: unknown = (result as { steps?: unknown }).steps;
            if (Array.isArray(steps))
              uncertain = steps.some(
                (step: unknown) =>
                  uncertainReceipt(step) ||
                  uncertainReceipt((step as { receipt?: unknown } | null)?.receipt)
              );
          }
          if (key === 'emitMessage' && result && typeof result === 'object')
            uncertain ||= (result as { reason?: string }).reason === 'dispatched-unconfirmed';
          return result;
        } catch (error) {
          const state = (error as { dispatchState?: string }).dispatchState;
          uncertain = state === 'unknown' || state === 'uncertain';
          throw error;
        } finally {
          if (typeof readReceipt === 'function') {
            const receipt: unknown = Reflect.apply(readReceipt, target, []);
            if (receipt !== previous && receipt && typeof receipt === 'object') {
              uncertain ||= uncertainReceipt(receipt);
            }
          }
          await cdp.send('daemon.endOperation', { operationId, uncertain }, null);
        }
      };
    },
  });
}
