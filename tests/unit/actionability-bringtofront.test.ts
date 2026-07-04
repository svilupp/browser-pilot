import { describe, expect, it, mock } from 'bun:test';
import { ensureActionable } from '../../src/browser/actionability.ts';
import type { CDPClient } from '../../src/cdp/client.ts';

/**
 * BUG F (actionability retry path): a backgrounded/occluded tab is rAF-throttled
 * by Chrome, so an element can report a zero-size rect indefinitely and the
 * actionability wait would poll to the full timeout. On the first zero-size
 * result, `ensureActionable` must foreground the tab ONCE via Page.bringToFront
 * and re-measure immediately.
 */

interface ScriptedClient {
  client: CDPClient;
  bringToFrontCount: () => number;
}

/**
 * Build a CDP mock whose visibility check returns zero-size until
 * Page.bringToFront is called, then returns actionable.
 */
function createScriptedClient(): ScriptedClient {
  let broughtToFront = false;
  let bringToFrontCount = 0;

  const client = {
    send: mock((method: string) => {
      if (method === 'Page.bringToFront') {
        broughtToFront = true;
        bringToFrontCount++;
        return Promise.resolve({});
      }
      if (method === 'Runtime.callFunctionOn') {
        // Before foreground: zero-size (rAF-throttled). After: actionable.
        if (!broughtToFront) {
          return Promise.resolve({
            result: {
              value: {
                actionable: false,
                reason:
                  'Element has zero size (0x0). Try scrolling or check if a prior action is needed to reveal it.',
              },
            },
          });
        }
        return Promise.resolve({ result: { value: { actionable: true } } });
      }
      return Promise.resolve({});
    }) as unknown as CDPClient['send'],
    isConnected: true,
  } as unknown as CDPClient;

  return { client, bringToFrontCount: () => bringToFrontCount };
}

describe('ensureActionable bringToFront on zero-size (BUG F)', () => {
  it('foregrounds the tab once and then passes the visible check', async () => {
    const scripted = createScriptedClient();

    await ensureActionable(scripted.client, 'obj-1', ['visible'], { timeout: 5000 });

    expect(scripted.bringToFrontCount()).toBe(1);
  });

  it('does not send bringToFront when the element is immediately actionable', async () => {
    let bringToFrontCount = 0;
    const client = {
      send: mock((method: string) => {
        if (method === 'Page.bringToFront') bringToFrontCount++;
        if (method === 'Runtime.callFunctionOn') {
          return Promise.resolve({ result: { value: { actionable: true } } });
        }
        return Promise.resolve({});
      }) as unknown as CDPClient['send'],
      isConnected: true,
    } as unknown as CDPClient;

    await ensureActionable(client, 'obj-1', ['visible'], { timeout: 5000 });

    expect(bringToFrontCount).toBe(0);
  });

  it('only tries bringToFront once even if the element stays zero-size', async () => {
    let bringToFrontCount = 0;
    const client = {
      send: mock((method: string) => {
        if (method === 'Page.bringToFront') {
          bringToFrontCount++;
          return Promise.resolve({});
        }
        if (method === 'Runtime.callFunctionOn') {
          return Promise.resolve({
            result: {
              value: {
                actionable: false,
                reason: 'Element has zero size (0x0).',
              },
            },
          });
        }
        return Promise.resolve({});
      }) as unknown as CDPClient['send'],
      isConnected: true,
    } as unknown as CDPClient;

    // Short timeout so the poll loop exits quickly after the one bringToFront.
    await expect(ensureActionable(client, 'obj-1', ['visible'], { timeout: 150 })).rejects.toThrow(
      /not actionable/
    );
    expect(bringToFrontCount).toBe(1);
  });
});
