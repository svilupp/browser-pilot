import { expect, test } from 'bun:test';
import { verifyChildSession, verifyDocumentContext } from '../../src/browser/frame-identity.ts';
import type { CDPClient } from '../../src/cdp/client.ts';

function fixture(value: unknown, frame = 'child') {
  const calls: Array<{
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string | null;
  }> = [];
  const cdp = {
    send: async (method, params, sessionId) => {
      calls.push({ method, params, sessionId });
      if (method === 'Runtime.evaluate') return { result: { objectId: 'context-document' } };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'document-object' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value } };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: frame } } };
      return {};
    },
  } as Pick<CDPClient, 'send'>;
  return { cdp: cdp as CDPClient, calls };
}

test('selected document/context identity is exact and temporary objects are released', async () => {
  const { cdp, calls } = fixture(true);
  await verifyDocumentContext(cdp, 20, 42);
  expect(calls[0]?.params).toEqual({ nodeId: 20, executionContextId: 42 });
  expect(calls.at(-1)?.method).toBe('Runtime.releaseObject');
});
test('parent document masquerading as selected child fails before any input', async () => {
  const { cdp, calls } = fixture(false);
  await expect(verifyDocumentContext(cdp, 20, 42)).rejects.toMatchObject({
    capability: 'FRAME_CONTEXT_MISMATCH',
  });
  expect(calls.some((call) => call.method.startsWith('Input.'))).toBe(false);
  expect(calls.at(-1)?.method).toBe('Runtime.releaseObject');
});
test('wrong result shape and foreign child frame remain distinct errors', async () => {
  await expect(verifyDocumentContext(fixture({}).cdp, 20, 42)).rejects.toMatchObject({
    capability: 'PROTOCOL_RESULT_INVALID',
  });
  const { cdp, calls } = fixture(true, 'foreign');
  await expect(verifyChildSession(cdp, 'child', 'child-session')).rejects.toMatchObject({
    capability: 'FRAME_CONTEXT_MISMATCH',
  });
  expect(calls[0]?.sessionId).toBe('child-session');
});
