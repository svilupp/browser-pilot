import type { ActionReceipt, DispatchState } from './types.ts';

/**
 * Tracks the side-effect boundary for one logical browser action.
 *
 * DOM resolution, scrolling, actionability checks, and coordinate calculation
 * happen before an effectful input event is accepted. Once an effectful event
 * is accepted (or its acknowledgement is uncertain), the action is no longer
 * safe to redispatch.
 */
export class ActionDispatch {
  private dispatchState: DispatchState = 'not_dispatched';
  private retrySafe = true;
  private inputEventsSent: string[] = [];
  private navigationObserved = false;

  get state(): DispatchState {
    return this.dispatchState;
  }

  get canRetryAction(): boolean {
    return this.dispatchState === 'not_dispatched' && this.retrySafe;
  }

  get hasPotentiallyDispatched(): boolean {
    return this.dispatchState !== 'not_dispatched';
  }

  /**
   * Send one CDP input operation and record whether it crossed the effectful
   * boundary. If CDP reports an error, the operation may still have reached
   * Chrome, so effectful operations become uncertain rather than retryable.
   */
  async send<T>(
    operation: () => Promise<T>,
    eventName: string,
    options: { effectful?: boolean } = {}
  ): Promise<T> {
    const effectful = options.effectful !== false;
    try {
      const result = await operation();
      this.record(eventName, effectful, false);
      return result;
    } catch (error) {
      if (effectful) {
        this.record(eventName, true, true);
      }
      throw error;
    }
  }

  observeNavigation(): void {
    this.navigationObserved = true;
  }

  toReceipt(): ActionReceipt {
    return {
      dispatchState: this.dispatchState,
      retrySafe: this.retrySafe,
      inputEventsSent: [...this.inputEventsSent],
      ...(this.navigationObserved ? { navigationObserved: true } : {}),
    };
  }

  private record(eventName: string, effectful: boolean, uncertain: boolean): void {
    this.inputEventsSent.push(eventName);
    if (!effectful) return;

    this.retrySafe = false;
    this.dispatchState = uncertain ? 'uncertain' : 'dispatched';
  }
}
