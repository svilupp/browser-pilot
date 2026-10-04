import { expect, test } from 'bun:test';
import { Page } from '../../src/browser/page.ts';
import { createCDPClientFromTransport } from '../../src/cdp/client.ts';
import type { Transport } from '../../src/cdp/transport.ts';

test('one keyboard action budget spans multiple CDP input acknowledgements and never replays late input', async () => {
  let message: ((raw: string) => void) | undefined;
  const requests: string[] = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const transport: Transport = {
    send(raw) {
      const request = JSON.parse(raw) as { id: number; method: string };
      requests.push(request.method);
      timers.push(setTimeout(() => message?.(JSON.stringify({ id: request.id, result: {} })), 50));
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
    },
    onMessage(handler) {
      message = handler;
    },
    onClose() {},
    onError() {},
  };
  const cdp = createCDPClientFromTransport(transport);
  const page = new Page(cdp, 'fixture');
  const started = Date.now();
  try {
    await expect(page.press('Enter', { timeout: 80 })).rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(180);
    expect(page.getLastActionReceipt()?.dispatchState).toBe('uncertain');
    const dispatched = requests.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requests.length).toBe(dispatched);
  } finally {
    await cdp.close();
  }
});
