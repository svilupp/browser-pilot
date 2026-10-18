/** One handback commit per grant/client, including concurrent callers and failed commits. */
export class HandbackCoordinator {
  private readonly receipts = new WeakMap<object, { targetId: string; result: Promise<unknown> }>();
  clear(client: object): void {
    this.receipts.delete(client);
  }
  commit(client: object, targetId: string, commit: () => Promise<unknown>): Promise<unknown> {
    const previous = this.receipts.get(client);
    if (previous) {
      if (previous.targetId !== targetId)
        return Promise.reject(new Error('Owner handback already selected another target'));
      return previous.result;
    }
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<unknown>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    this.receipts.set(client, { targetId, result });
    // Install the promise first, but close admission synchronously inside commit.
    try {
      void commit().then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return result;
  }
}
