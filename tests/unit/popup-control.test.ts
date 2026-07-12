import { describe, expect, test } from 'bun:test';
import type { Browser } from '../../src/browser/browser.ts';
import { TargetNotFoundError } from '../../src/browser/types.ts';
import type { TargetInfo } from '../../src/cdp/protocol.ts';

type Handler = (params: Record<string, unknown>) => void;

function makeTarget(overrides: Partial<TargetInfo> = {}): TargetInfo {
  return {
    targetId: 'popup',
    type: 'page',
    title: '',
    url: 'about:blank',
    attached: false,
    canAccessOpener: true,
    ...overrides,
  };
}

function makeBrowser() {
  const handlers = new Map<string, Set<Handler>>();
  const targets: TargetInfo[] = [];
  const sent: Array<{
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string | null;
  }> = [];
  const cdp = {
    sent,
    targets,
    async send(method: string, params?: Record<string, unknown>, sessionId?: string | null) {
      sent.push({ method, params, sessionId });
      if (method === 'Target.getTargets') return { targetInfos: targets };
      if (method === 'Runtime.evaluate') return { result: { value: { w: 1280, h: 720 } } };
      return {};
    },
    on(event: string, handler: Handler) {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(event, set);
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
    },
    onAny() {},
    offAny() {},
    onSessionEvent() {
      return () => {};
    },
    onTargetAttached() {
      return () => {};
    },
    setAutoAttach: async () => {},
    runIfWaitingForDebugger: async () => {},
    attachToTarget: async (targetId: string) => {
      sent.push({ method: 'Target.attachToTarget', params: { targetId } });
      return `session-${targetId}`;
    },
    get sessions() {
      return new Set<string>();
    },
    hasSession: () => false,
    sessionId: undefined as string | undefined,
    setSessionId() {},
    close: async () => {},
    get isConnected() {
      return true;
    },
    emit(event: string, params: Record<string, unknown>) {
      for (const handler of handlers.get(event) ?? []) handler(params);
    },
  };

  return cdp;
}

async function createTestBrowser() {
  const { Browser } = await import('../../src/browser/browser.ts');
  const cdp = makeBrowser();
  type BrowserHarness = Pick<Browser, 'expectNewPage'> & {
    cdp: ReturnType<typeof makeBrowser>;
    pages: Map<string, { targetId: string }>;
    pageCounter: number;
  };
  const browser = Object.create(Browser.prototype) as BrowserHarness;
  browser.cdp = cdp;
  browser.pages = new Map();
  browser.pageCounter = 0;
  return { browser, cdp };
}

describe('Browser.expectNewPage', () => {
  test('enables target discovery during Browser initialization', async () => {
    const { Browser } = await import('../../src/browser/browser.ts');
    const cdp = makeBrowser();
    Browser.fromCDP(cdp as never, { wsUrl: 'ws://test' });

    await Promise.resolve();
    expect(
      cdp.sent.find(
        (call) =>
          call.method === 'Target.setDiscoverTargets' &&
          call.params?.['discover'] === true &&
          call.sessionId === null
      )
    ).toBeDefined();
  });

  test('arms before the trigger, ignores unrelated popups, and follows delayed about:blank navigation', async () => {
    const { browser, cdp } = await createTestBrowser();
    const opener = { targetId: 'launcher' };
    browser.pages.set('default', opener);

    const popup = browser.expectNewPage(
      async () => {
        cdp.emit('Target.targetCreated', {
          targetInfo: makeTarget({ targetId: 'unrelated', openerId: 'other' }),
        });
        cdp.emit('Target.targetCreated', {
          targetInfo: makeTarget({ targetId: 'wanted', openerId: 'launcher' }),
        });
        await Promise.resolve();
        cdp.emit('Target.targetInfoChanged', {
          targetInfo: makeTarget({
            targetId: 'wanted',
            openerId: 'launcher',
            url: 'https://popup.example/store',
            title: 'Expected popup',
          }),
        });
      },
      { openerTargetId: 'launcher', url: /popup\.example/, timeout: 500 }
    );

    const page = await popup;
    expect(page.targetId).toBe('wanted');
    expect(cdp.sent.some((call) => call.method === 'Target.attachToTarget')).toBe(true);
    expect(browser.pages.get('default')).toBe(opener);
    expect([...browser.pages.values()]).toContain(page);
  });

  test('fails closed when the matching target disappears', async () => {
    const { browser, cdp } = await createTestBrowser();
    const pending = browser.expectNewPage(
      async () => {
        cdp.emit('Target.targetCreated', {
          targetInfo: makeTarget({ targetId: 'gone', openerId: 'launcher' }),
        });
        cdp.emit('Target.targetDestroyed', { targetId: 'gone' });
      },
      { openerTargetId: 'launcher', url: 'https://popup.example', timeout: 100 }
    );

    await expect(pending).rejects.toBeInstanceOf(TargetNotFoundError);
  });

  test('waits for delayed title metadata when title is part of the filter', async () => {
    const { browser, cdp } = await createTestBrowser();
    const pending = browser.expectNewPage(
      async () => {
        cdp.emit('Target.targetCreated', {
          targetInfo: makeTarget({
            targetId: 'titled',
            openerId: 'launcher',
            url: 'https://example.test',
          }),
        });
        await Promise.resolve();
        cdp.emit('Target.targetInfoChanged', {
          targetInfo: makeTarget({
            targetId: 'titled',
            openerId: 'launcher',
            url: 'https://example.test',
            title: 'Expected popup',
          }),
        });
      },
      {
        openerTargetId: 'launcher',
        url: 'https://example.test',
        title: 'Expected popup',
        timeout: 500,
      }
    );

    const page = await pending;
    expect(page.targetId).toBe('titled');
  });

  test('refreshes title metadata when Chrome omits a title-change event', async () => {
    const { browser, cdp } = await createTestBrowser();
    const target = makeTarget({
      targetId: 'listed-title',
      openerId: 'launcher',
      url: 'https://example.test',
      title: 'https://example.test',
    });
    cdp.targets.push(target);
    const pending = browser.expectNewPage(
      async () => {
        cdp.emit('Target.targetCreated', { targetInfo: target });
        await Bun.sleep(75);
        target.title = 'Expected popup';
      },
      {
        openerTargetId: 'launcher',
        url: 'https://example.test',
        title: 'Expected popup',
        timeout: 500,
      }
    );

    const page = await pending;
    expect(page.targetId).toBe('listed-title');
  });

  test('fails closed when multiple newly created targets match the expectation', async () => {
    const { browser, cdp } = await createTestBrowser();
    let releaseAttach!: () => void;
    const attachBlocked = new Promise<void>((resolve) => {
      releaseAttach = resolve;
    });
    cdp.attachToTarget = async (targetId: string) => {
      await attachBlocked;
      cdp.sent.push({ method: 'Target.attachToTarget', params: { targetId } });
      return `session-${targetId}`;
    };

    const pending = browser.expectNewPage(
      async () => {
        cdp.emit('Target.targetCreated', {
          targetInfo: makeTarget({
            targetId: 'first-match',
            openerId: 'launcher',
            url: 'https://example.test/result',
          }),
        });
        cdp.emit('Target.targetCreated', {
          targetInfo: makeTarget({
            targetId: 'second-match',
            openerId: 'launcher',
            url: 'https://example.test/result',
          }),
        });
        releaseAttach();
      },
      { openerTargetId: 'launcher', url: 'https://example.test/result', timeout: 500 }
    );

    await expect(pending).rejects.toThrow('ambiguous');
    expect(browser.pages.size).toBe(0);
  });
});
