import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Group } from '@sattle/core';

import { ApiClient } from './ApiClient';
import { MockClient } from './MockClient';
import { ActionKeys } from './SattleClient';

const manali = { name: 'Manali', currency: 'INR', memberNames: ['Riya'] };

afterEach(() => vi.restoreAllMocks());

describe('ActionKeys', () => {
  it('reuses the key after an error and mints a new one after success', async () => {
    const keys = new ActionKeys();
    const seen: string[] = [];
    const attempt = (fail: boolean) =>
      keys.run('create-group', manali, async (k) => {
        seen.push(k);
        if (fail) throw new Error('network');
        return k;
      });

    await expect(attempt(true)).rejects.toThrow('network');
    await attempt(false);
    await attempt(false);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).not.toBe(seen[1]);
  });

  it('gives a different input its own key', async () => {
    const keys = new ActionKeys();
    const a = await keys.run('settle', { rail: 'invoice' }, async (k) => k);
    const b = await keys.run('settle', { rail: 'lightning_address' }, async (k) => k);
    expect(a).not.toBe(b);
  });
});

describe('ApiClient', () => {
  it('sends the same idempotency-key when an action is retried after a network error', async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push((init.headers as Record<string, string>)['idempotency-key']);
        if (sent.length === 1) throw new TypeError('Network request failed');
        return new Response(JSON.stringify({ id: 'g-1' }), { status: 201 });
      })
    );
    const client = new ApiClient('http://api.test');
    const keys = new ActionKeys();
    const create = () => keys.run('create-group', manali, (k) => client.createGroup(manali, k));

    await expect(create()).rejects.toMatchObject({ code: 'network' });
    await create();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
  });

  it('still sends a fresh key when the caller passes none', async () => {
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push((init.headers as Record<string, string>)['idempotency-key']);
        return new Response('{}', { status: 201 });
      })
    );
    const client = new ApiClient('http://api.test');
    await client.createGroup(manali);
    await client.createGroup(manali);
    expect(sent[0]).toBeTruthy();
    expect(sent[1]).not.toBe(sent[0]);
  });
});

describe('MockClient with failureRate', () => {
  /**
   * The next mock call does its write and then loses the reply. Calls after
   * that never fail, and Math.random stays random for minting keys.
   */
  function loseNextReply() {
    const real = Math.random;
    vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0) // fails…
      .mockReturnValueOnce(0.9) // …after the write
      .mockImplementation(() => 0.5 + real() * 0.5);
  }

  const client = () => new MockClient({ latencyMs: 0, failureRate: 0.5 });

  /** Runs `call` as one user action, losing the reply of its first attempt. */
  function action<T>(call: (key: string) => Promise<T>) {
    const keys = new ActionKeys();
    let first = true;
    return () =>
      keys.run('action', 'same input', (k) => {
        if (first) loseNextReply();
        first = false;
        return call(k);
      });
  }

  const manalis = async (c: MockClient) => (await c.getGroups()).filter((g: Group) => g.name === 'Manali');

  it('replays the lost reply when the retry reuses the key', async () => {
    const c = client();
    const create = action((k) => c.createGroup(manali, k));

    await expect(create()).rejects.toMatchObject({ code: 'network' });
    const group = await create();
    expect(await manalis(c)).toEqual([group]);
  });

  it('makes a duplicate when the retry uses a new key, which is the bug keys prevent', async () => {
    const c = client();
    loseNextReply();
    await expect(c.createGroup(manali)).rejects.toMatchObject({ code: 'network' });
    await c.createGroup(manali);
    expect(await manalis(c)).toHaveLength(2);
  });

  it('still walks a settlement whose reply was lost', async () => {
    const c = client();
    const input = {
      groupId: 'g-goa',
      fromMemberId: 'm-goa-yash',
      toMemberId: 'm-goa-om',
      amount: 1000,
      rail: 'in_app' as const,
    };
    const settle = action((k) => c.createSettlement(input, k));

    await expect(settle()).rejects.toMatchObject({ code: 'network' });
    const s = await settle();
    const settlements = (await c.getSettlements('g-goa')).filter((x) => x.amount === 1000);
    expect(settlements.map((x) => x.id)).toEqual([s.id]);
    await vi.waitFor(async () => expect((await c.getSettlement(s.id)).status).not.toBe('created'), {
      timeout: 2000,
    });
  });
});
