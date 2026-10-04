import { expect, spyOn, test } from 'bun:test';
import { type BrowserBinding, connect } from '../../src/adapters/workers/index.ts';

function bindingFixture() {
  const allocations: string[] = [];
  const releases: string[] = [];
  const binding: BrowserBinding = {
    async acquire() {
      allocations.push('allocation');
      return { sessionId: 'allocation' };
    },
    async connectSession() {
      throw new Error('upgrade failed');
    },
    async closeSession(id) {
      releases.push(id);
      return { status: 'closed' };
    },
    async getSession() {
      return null;
    },
  };
  return { binding, allocations, releases };
}

test('invalid connection budgets cannot allocate a binding browser', async () => {
  const f = bindingFixture();
  for (const timeout of [0, -1, NaN, Infinity]) {
    await expect(
      connect({ provider: 'cloudflare', cloudflare: { binding: f.binding }, timeout })
    ).rejects.toMatchObject({ capability: 'deadline' });
  }
  expect(f.allocations).toEqual([]);
});

test('allocation exhausting the setup budget is released by exact ID', async () => {
  const f = bindingFixture();
  let now = 1000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const acquire = f.binding.acquire;
  f.binding.acquire = async () => {
    const allocation = await acquire();
    now += 100;
    return allocation;
  };
  try {
    await expect(
      connect({ provider: 'cloudflare', cloudflare: { binding: f.binding }, timeout: 50 })
    ).rejects.toMatchObject({ capability: 'deadline' });
    expect(f.allocations).toEqual(['allocation']);
    expect(f.releases).toEqual(['allocation']);
  } finally {
    clock.mockRestore();
  }
});

test('failed binding upgrade releases owned allocation once and preserves borrowed allocation', async () => {
  for (const providerSessionId of [undefined, 'external']) {
    const f = bindingFixture();
    await expect(
      connect({
        provider: 'cloudflare',
        cloudflare: { binding: f.binding, providerSessionId },
      })
    ).rejects.toThrow('upgrade failed');
    expect(f.allocations).toEqual(providerSessionId ? [] : ['allocation']);
    expect(f.releases).toEqual(providerSessionId ? [] : ['allocation']);
  }
});
