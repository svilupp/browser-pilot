import { describe, expect, test } from 'bun:test';
import { LeaseController } from '../../src/owner/lease-controller.ts';

describe('browser owner fencing', () => {
  test('grants are socket and epoch bound, sequence reserved once in admission order', () => {
    const owner = new LeaseController();
    const client = {},
      other = {};
    const grant = owner.acquire(client);
    expect(() => owner.acquire(other)).toThrow('session_busy');
    expect(() => owner.admit(other, { ...grant, sequence: 1 })).toThrow();
    expect(() => owner.admit(client, { ...grant, ownerEpoch: 'old', sequence: 1 })).toThrow();
    const first = owner.admit(client, { ...grant, sequence: 1 });
    const second = owner.admit(client, { ...grant, sequence: 2 });
    owner.assertCurrent(first);
    expect(() => owner.admit(client, { ...grant, sequence: 2 })).toThrow();
    owner.finish(second);
    owner.finish(first);
    owner.release(client);
    expect(owner.acquire(other).grantId).not.toBe(grant.grantId);
  });
  test('handback closes admission before waiting for pending work', async () => {
    const owner = new LeaseController(),
      client = {};
    const grant = owner.acquire(client);
    const pending = owner.admit(client, { ...grant, sequence: 1 });
    let drained = false;
    const freeze = owner.freeze(client).then(() => {
      drained = true;
    });
    expect(() => owner.admit(client, { ...grant, sequence: 2 })).toThrow();
    await Promise.resolve();
    expect(drained).toBe(false);
    owner.finish(pending);
    await freeze;
    owner.release(client);
    expect(owner.active).toBe(false);
  });
  test('unknown remote work quarantines even after socket disconnect', () => {
    const owner = new LeaseController(),
      client = {};
    const grant = owner.acquire(client);
    const pending = owner.admit(client, { ...grant, sequence: 1 });
    owner.disconnected(client);
    owner.finish(pending, true);
    expect(() => owner.acquire({})).toThrow();
    expect(() => owner.release(client)).toThrow();
  });
});
