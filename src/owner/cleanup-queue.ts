import { OwnerLeaseError } from './lease-controller.ts';

/** Serialize owner-private cleanup before the next controller receives authority. */
export class OwnerCleanupQueue {
  private barrier: Promise<void> = Promise.resolve();
  private failed = false;
  private readonly completed = new Set<string>();
  private readonly observers = new Set<string>();
  constructor(private readonly detachObserver: (sessionId: string) => Promise<void>) {}
  private schedule(task: () => Promise<void>): void {
    this.barrier = this.barrier.then(task).catch(() => {
      this.failed = true;
    });
  }
  queueObservers(sessionIds: readonly string[]): void {
    for (const id of sessionIds) this.observers.add(id);
  }
  drainObservers(idle: boolean): void {
    if (!idle || !this.observers.size) return;
    const ids = [...this.observers];
    this.observers.clear();
    this.schedule(async () => {
      for (const id of ids) await this.detachObserver(id);
    });
  }
  markComplete(grantId: string): void {
    this.completed.add(grantId);
  }
  leaseEnded(grantId: string, cleanup: () => Promise<void>): void {
    if (this.completed.has(grantId)) return;
    this.markComplete(grantId);
    this.schedule(cleanup);
  }
  async ready(): Promise<void> {
    let waited: Promise<void>;
    do {
      waited = this.barrier;
      await waited;
    } while (waited !== this.barrier);
    if (this.failed)
      throw new OwnerLeaseError('session_busy: owner cleanup requires reconciliation');
  }
}
