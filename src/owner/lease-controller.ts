/** Browser-wide admission. This module deliberately knows nothing about sockets or CDP. */
export interface OwnerGrant {
  ownerEpoch: string;
  grantId: string;
}
export interface OwnerFence extends OwnerGrant {
  sequence: number;
}
export interface OwnerAdmission {
  readonly fence: OwnerFence;
  readonly client: object;
}
export class OwnerLeaseError extends Error {
  readonly code = -32005;
}

/** A disconnected or timed-out consequential request never silently unlocks the browser. */
export class LeaseController {
  readonly ownerEpoch = crypto.randomUUID();
  private lease?: {
    client: object;
    grant: OwnerGrant;
    state: 'active' | 'frozen' | 'uncertain';
    sequence: number;
    pending: Set<OwnerAdmission>;
    disconnected: boolean;
    drained: Array<() => void>;
  };

  get active(): boolean {
    return this.lease !== undefined;
  }
  owns(client: object): boolean {
    return this.lease?.client === client;
  }
  validateControl(client: object, fence?: OwnerFence): void {
    const lease = this.lease;
    if (
      !lease ||
      lease.client !== client ||
      !fence ||
      fence.ownerEpoch !== this.ownerEpoch ||
      fence.grantId !== lease.grant.grantId ||
      !Number.isSafeInteger(fence.sequence) ||
      fence.sequence <= lease.sequence
    )
      throw new OwnerLeaseError('session_busy: stale owner control fence');
    lease.sequence = fence.sequence;
  }
  acquire(client: object): OwnerGrant {
    if (this.lease) {
      if (this.lease.client === client && this.lease.state === 'active') return this.lease.grant;
      throw new OwnerLeaseError('session_busy: browser owner is held or quarantined');
    }
    const grant = { ownerEpoch: this.ownerEpoch, grantId: crypto.randomUUID() };
    this.lease = {
      client,
      grant,
      state: 'active',
      sequence: 0,
      pending: new Set(),
      disconnected: false,
      drained: [],
    };
    return grant;
  }
  /** Called synchronously in socket message order, before any asynchronous work. */
  admit(client: object, fence?: OwnerFence, continuation?: OwnerAdmission): OwnerAdmission {
    const lease = this.lease;
    if (
      !lease ||
      lease.client !== client ||
      (lease.state !== 'active' &&
        !(
          lease.state === 'frozen' &&
          continuation &&
          lease.pending.has(continuation) &&
          continuation.client === client
        )) ||
      !fence ||
      fence.ownerEpoch !== this.ownerEpoch ||
      fence.grantId !== lease.grant.grantId ||
      !Number.isSafeInteger(fence.sequence) ||
      fence.sequence <= lease.sequence
    )
      throw new OwnerLeaseError('session_busy: stale, absent, or revoked owner fence');
    lease.sequence = fence.sequence;
    const admitted = { client, fence };
    lease.pending.add(admitted);
    return admitted;
  }
  assertCurrent(admission: OwnerAdmission): void {
    const lease = this.lease;
    if (
      !lease ||
      lease.client !== admission.client ||
      lease.grant.grantId !== admission.fence.grantId ||
      lease.state === 'uncertain' ||
      lease.disconnected ||
      !lease.pending.has(admission)
    )
      throw new OwnerLeaseError('session_busy: admitted operation has been revoked');
  }
  finish(admission: OwnerAdmission, uncertain = false): void {
    const lease = this.lease;
    if (!lease || !lease.pending.delete(admission)) return;
    if (uncertain) lease.state = 'uncertain';
    if (lease.pending.size === 0) {
      for (const resolve of lease.drained.splice(0)) resolve();
      if (lease.disconnected && lease.state !== 'uncertain') this.lease = undefined;
    }
  }
  async freeze(client: object): Promise<OwnerGrant> {
    const lease = this.lease;
    if (!lease || lease.client !== client || lease.state === 'uncertain')
      throw new OwnerLeaseError('session_busy: owner cannot hand back uncertain work');
    lease.state = 'frozen';
    if (lease.pending.size) await new Promise<void>((resolve) => lease.drained.push(resolve));
    if ((lease.state as string) === 'uncertain' || lease.disconnected)
      throw new OwnerLeaseError('session_busy: owner handback is uncertain');
    return lease.grant;
  }
  /** Pin a frozen lifecycle transaction until its commit/cleanup has a known outcome. */
  holdFrozen(client: object): OwnerAdmission {
    const lease = this.lease;
    if (!lease || lease.client !== client || lease.state !== 'frozen' || lease.disconnected)
      throw new OwnerLeaseError('session_busy: frozen owner transaction is unavailable');
    const admission = { client, fence: { ...lease.grant, sequence: lease.sequence } };
    lease.pending.add(admission);
    return admission;
  }
  release(client: object): void {
    const lease = this.lease;
    if (!lease) return;
    if (lease.client !== client || lease.pending.size || lease.state === 'uncertain')
      throw new OwnerLeaseError('session_busy: owner has pending or uncertain work');
    this.lease = undefined;
  }
  disconnected(client: object): void {
    const lease = this.lease;
    if (!lease || lease.client !== client) return;
    lease.disconnected = true;
    if (lease.pending.size === 0 && lease.state !== 'uncertain') this.lease = undefined;
  }
}
