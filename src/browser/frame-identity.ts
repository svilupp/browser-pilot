import type { CDPClient } from '../cdp/client.ts';
import { CapabilityError } from '../core/ports.ts';

/** Bind a selected document node to its expected JS realm before any user input. */
export async function verifyDocumentContext(
  cdp: CDPClient,
  nodeId: number,
  contextId: number
): Promise<void> {
  const { object } = await cdp.send<{ object?: { objectId?: string } }>('DOM.resolveNode', {
    nodeId,
    executionContextId: contextId,
  });
  if (!object?.objectId)
    throw new CapabilityError(
      'PROTOCOL_RESULT_INVALID',
      'Selected document has no Runtime identity'
    );
  let contextDocument: string | undefined;
  try {
    // Check the evaluate route as well as the object route: an engine can
    // resolve the child node correctly while ignoring evaluate's contextId.
    const evaluated = await cdp.send<{ result?: { objectId?: string } }>('Runtime.evaluate', {
      expression: 'document',
      contextId,
      returnByValue: false,
    });
    contextDocument = evaluated.result?.objectId;
    if (!contextDocument)
      throw new CapabilityError(
        'PROTOCOL_RESULT_INVALID',
        'Selected context returned no document object'
      );
    const response = await cdp.send<{ result?: { value?: unknown } }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration:
        'function(selectedDocument) { return this.nodeType === 9 && this === document && this === selectedDocument; }',
      arguments: [{ objectId: contextDocument }],
      returnByValue: true,
    });
    if (typeof response.result?.value !== 'boolean')
      throw new CapabilityError(
        'PROTOCOL_RESULT_INVALID',
        'Selected document identity probe returned malformed result'
      );
    if (!response.result.value)
      throw new CapabilityError(
        'FRAME_CONTEXT_MISMATCH',
        'Selected child document does not belong to its execution context'
      );
  } finally {
    if (contextDocument && contextDocument !== object.objectId)
      await cdp.send('Runtime.releaseObject', { objectId: contextDocument }).catch(() => {});
    await cdp.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
  }
}

/** A child session must report the exact frame selected from the owning document. */
export async function verifyChildSession(
  cdp: CDPClient,
  frameId: string,
  sessionId: string
): Promise<void> {
  const response = await cdp.send<{ frameTree?: { frame?: { id?: string } } }>(
    'Page.getFrameTree',
    undefined,
    sessionId
  );
  const actual = response.frameTree?.frame?.id;
  if (typeof actual !== 'string')
    throw new CapabilityError(
      'PROTOCOL_RESULT_INVALID',
      'Child session returned no frame identity'
    );
  if (actual !== frameId)
    throw new CapabilityError('FRAME_CONTEXT_MISMATCH', 'Child session reports a different frame');
}
