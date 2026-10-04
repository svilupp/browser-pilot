import type { CDPClient } from './client.ts';

/** Own exactly one binding/script registration and dispose it in every live context. */
export class PageScript {
  private identifier?: string;
  private readonly contexts = new Set<number>();
  private listening = false;
  private readonly onBinding = (params: Record<string, unknown>) => {
    if (params['name'] === this.binding && typeof params['executionContextId'] === 'number')
      this.contexts.add(params['executionContextId']);
  };
  private readonly onContext = (params: Record<string, unknown>) => {
    const context = params['context'] as { id?: number } | undefined;
    if (typeof context?.id === 'number') this.contexts.add(context.id);
  };
  private readonly onDestroyed = (params: Record<string, unknown>) => {
    if (typeof params['executionContextId'] === 'number')
      this.contexts.delete(params['executionContextId']);
  };
  private readonly onCleared = () => {
    this.contexts.clear();
  };
  constructor(
    private readonly cdp: CDPClient,
    readonly binding: string,
    private readonly source: string,
    private readonly cleanup: string,
    private readonly futureDocuments = true
  ) {}
  async install(): Promise<void> {
    this.listening = true;
    this.cdp.on('Runtime.bindingCalled', this.onBinding);
    this.cdp.on('Runtime.executionContextCreated', this.onContext);
    this.cdp.on('Runtime.executionContextDestroyed', this.onDestroyed);
    this.cdp.on('Runtime.executionContextsCleared', this.onCleared);
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.addBinding', { name: this.binding });
    if (this.futureDocuments) {
      const result = await this.cdp.send<{ identifier: string }>(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: this.source }
      );
      this.identifier = result.identifier;
    }
    const result = await this.cdp.send<{ exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression: this.source,
      awaitPromise: false,
    });
    if (result.exceptionDetails) throw new Error('Page recording script initialization failed');
  }
  async dispose(): Promise<string[]> {
    const errors: string[] = [];
    const perform = async (method: string, params: Record<string, unknown>) => {
      try {
        const result = await this.cdp.send<{ exceptionDetails?: unknown }>(
          method,
          params,
          undefined,
          { timeout: 2000 }
        );
        if (result.exceptionDetails) errors.push(`${method} failed in page`);
      } catch {
        errors.push(`${method} failed`);
      }
    };
    if (this.identifier) {
      await perform('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.identifier });
      this.identifier = undefined;
    }
    if (this.listening) {
      await Promise.all(
        [...this.contexts].map((contextId) =>
          perform('Runtime.evaluate', { expression: this.cleanup, contextId })
        )
      );
      if (!this.contexts.size) await perform('Runtime.evaluate', { expression: this.cleanup });
      await perform('Runtime.removeBinding', { name: this.binding });
      this.cdp.off('Runtime.bindingCalled', this.onBinding);
      this.cdp.off('Runtime.executionContextCreated', this.onContext);
      this.cdp.off('Runtime.executionContextDestroyed', this.onDestroyed);
      this.cdp.off('Runtime.executionContextsCleared', this.onCleared);
      this.listening = false;
      this.contexts.clear();
    }
    return errors;
  }
}
