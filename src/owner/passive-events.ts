const TELEMETRY = new Set([
  'Network.webSocketCreated',
  'Network.webSocketFrameSent',
  'Network.webSocketFrameReceived',
  'Network.webSocketClosed',
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.loadingFinished',
  'Network.loadingFailed',
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown',
  'Runtime.bindingCalled',
  'Runtime.executionContextCreated',
  'Runtime.executionContextDestroyed',
  'Runtime.executionContextsCleared',
]);

/** Observation capability is socket/session scoped and confers no command authority. */
export class PassiveEvents {
  private readonly attached = new Map<object, Set<string>>();
  private readonly disposable = new Map<object, Set<string>>();
  private readonly subscriptions = new Map<object, { sessionId: string; logicalSession: string }>();
  constructor(
    private readonly revoked?: (client: object, sessionId: string, reason: string) => void
  ) {}
  attach(client: object, sessionId: string): void {
    const owned = this.attached.get(client) ?? new Set<string>();
    owned.add(sessionId);
    this.attached.set(client, owned);
  }
  observeAttachment(client: object, sessionId: string): void {
    this.attach(client, sessionId);
    const ids = this.disposable.get(client) ?? new Set<string>();
    ids.add(sessionId);
    this.disposable.set(client, ids);
  }
  takeCleanup(client: object): string[] {
    const ids = [...(this.disposable.get(client) ?? [])];
    this.disposable.delete(client);
    return ids;
  }
  subscribe(client: object, sessionId: string, logicalSession: string): void {
    if (!this.disposable.get(client)?.has(sessionId))
      throw new Error(
        'Passive subscription requires an observer session attached by this controller'
      );
    this.subscriptions.set(client, { sessionId, logicalSession });
  }
  permits(client: object, method: string, sessionId?: string): boolean {
    return (
      sessionId !== undefined &&
      this.subscriptions.get(client)?.sessionId === sessionId &&
      TELEMETRY.has(method)
    );
  }
  revoke(client: object, reason = 'requested'): void {
    const previous = this.subscriptions.get(client);
    this.subscriptions.delete(client);
    if (previous) this.revoked?.(client, previous.sessionId, reason);
  }
  revokeLogical(logicalSession: string): void {
    for (const [client, value] of this.subscriptions)
      if (value.logicalSession === logicalSession) this.revoke(client, 'session_changed');
  }
  detach(sessionId: string): void {
    for (const ids of this.attached.values()) ids.delete(sessionId);
    for (const ids of this.disposable.values()) ids.delete(sessionId);
    for (const [client, value] of this.subscriptions)
      if (value.sessionId === sessionId) this.revoke(client, 'target_detached');
  }
  disconnect(client: object): void {
    this.revoke(client, 'disconnected');
    this.attached.delete(client);
  }
}
