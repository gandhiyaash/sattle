import { describe, expect, it } from 'vitest';

import { fixtures, type Debt, type GuestView, type PayLink } from '@sattle/core';

import { createApp } from './app';
import { openDb, seedIfEmpty } from './db';
import { SimulatedPayments, type PaymentBackend } from './payments';
import type { Repo } from './repo';

type Payments = 'simulated' | 'failing' | 'stalled';

function setup(payments: Payments = 'simulated') {
  const db = openDb(':memory:');
  seedIfEmpty(db);
  const backend = (repo: Repo): PaymentBackend =>
    payments === 'stalled'
      ? { start() {} }
      : new SimulatedPayments(repo, {
          stepMs: 1,
          settleDelayMs: 1,
          rateFiatPerBtc: 9_000_000,
          alwaysFail: payments === 'failing',
        });
  const app = createApp({ db, demoUserId: 'u-yash', payments: backend });

  async function call<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  const debt = async (groupId: string, from: string, to: string) =>
    (await call<Debt[]>('GET', `/groups/${groupId}/debts`)).body.find(
      (d) => d.fromMemberId === from && d.toMemberId === to
    )!;

  /**
   * Priya owes Yash in Flat 4B; Yash (the demo user) is the payee. Not Om's
   * debt: the seeded demo link is already paying that one.
   */
  const priyaOwesYash = () => debt('g-flat', 'm-flat-priya', 'm-flat-yash');

  const createLink = async (amount?: number) => {
    const d = await priyaOwesYash();
    const res = await call<PayLink>('POST', '/groups/g-flat/pay-links', {
      fromMemberId: d.fromMemberId,
      toMemberId: d.toMemberId,
      amount: amount ?? d.amount,
    });
    expect(res.status).toBe(201);
    return res.body;
  };

  const settlementCount = () =>
    (db.prepare('SELECT COUNT(*) AS n FROM settlements').get() as { n: number }).n;

  const waitForGuest = async (token: string, ok: (v: GuestView) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const { body } = await call<GuestView>('GET', `/s/${token}`);
      if (ok(body)) return body;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('timed out');
  };

  return { db, call, debt, priyaOwesYash, createLink, settlementCount, waitForGuest };
}

describe('POST /groups/:id/pay-links', () => {
  it('lets the payee create a link with an unguessable token', async () => {
    const { createLink, priyaOwesYash } = setup();
    const d = await priyaOwesYash();
    const link = await createLink();
    expect(link).toMatchObject({ groupId: 'g-flat', fromMemberId: 'm-flat-priya', toMemberId: 'm-flat-yash', amount: d.amount });
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('refuses anyone but the person owed', async () => {
    const { call, debt } = setup();
    // In Goa, Yash owes Om: Yash can't send a link asking himself to pay.
    const d = await debt('g-goa', 'm-goa-yash', 'm-goa-om');
    const { status, body } = await call<{ code: string }>('POST', '/groups/g-goa/pay-links', {
      fromMemberId: d.fromMemberId,
      toMemberId: d.toMemberId,
      amount: d.amount,
    });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_input');
  });

  it('caps the amount at what is owed', async () => {
    const { call, priyaOwesYash } = setup();
    const d = await priyaOwesYash();
    const { status, body } = await call<{ code: string }>('POST', '/groups/g-flat/pay-links', {
      fromMemberId: d.fromMemberId,
      toMemberId: d.toMemberId,
      amount: d.amount + 1,
    });
    expect(status).toBe(409);
    expect(body.code).toBe('conflict');
  });

  it('refuses a member from another group', async () => {
    const { call } = setup();
    const { status } = await call('POST', '/groups/g-flat/pay-links', {
      fromMemberId: 'm-goa-om',
      toMemberId: 'm-goa-yash',
      amount: 100,
    });
    expect(status).toBe(404);
  });
});

describe('POST /s/:token/open', () => {
  it('404s an unknown token', async () => {
    const { call } = setup();
    const { status, body } = await call<{ code: string }>('POST', '/s/nope/open');
    expect(status).toBe(404);
    expect(body.code).toBe('not_found');
  });

  it('mints an invoice settlement and walks it to confirmed', async () => {
    const { call, createLink, waitForGuest, priyaOwesYash } = setup();
    const link = await createLink();
    const { status, body } = await call<GuestView>('POST', `/s/${link.token}/open`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ payerName: 'Priya', payeeName: 'Yash', reason: 'Flat 4B' });
    expect(body.settlement).toMatchObject({ status: 'created', amount: link.amount, currency: 'INR' });

    const done = await waitForGuest(link.token, (v) => v.settlement?.status === 'confirmed');
    expect(done.settlement!.preimage).toMatch(/^[0-9a-f]{64}$/);
    expect(done.settlement!.destination).toMatch(/^lnbc/);
    expect(await priyaOwesYash()).toBeUndefined();
  });

  it('returns the settlement already in progress instead of minting a second', async () => {
    const { call, createLink, settlementCount } = setup('stalled');
    const link = await createLink();
    const first = await call<GuestView>('POST', `/s/${link.token}/open`);
    const before = settlementCount();
    const again = await call<GuestView>('POST', `/s/${link.token}/open`);
    expect(again.body.settlement!.id).toBe(first.body.settlement!.id);
    expect(settlementCount()).toBe(before);
  });

  it('returns the seeded demo link’s invoice while its quote is live', async () => {
    const { call, settlementCount } = setup('stalled');
    const before = settlementCount();
    const { status, body } = await call<GuestView>('POST', '/s/demo/open');
    expect(status).toBe(200);
    expect(body.settlement).toMatchObject({ id: 'demo', status: 'awaiting_payment' });
    expect(settlementCount()).toBe(before);
  });

  it('shows Paid on a confirmed link rather than expiring it', async () => {
    const { call, createLink, waitForGuest, settlementCount } = setup();
    const link = await createLink();
    await call('POST', `/s/${link.token}/open`);
    const paid = await waitForGuest(link.token, (v) => v.settlement?.status === 'confirmed');
    const before = settlementCount();

    const { status, body } = await call<GuestView>('POST', `/s/${link.token}/open`);
    expect(status).toBe(200);
    expect(body.settlement).toMatchObject({ id: paid.settlement!.id, status: 'confirmed' });
    expect(settlementCount()).toBe(before);
  });

  it('mints a fresh invoice after the last one failed', async () => {
    const { call, createLink, waitForGuest } = setup('failing');
    const link = await createLink();
    await call('POST', `/s/${link.token}/open`);
    const failed = await waitForGuest(link.token, (v) => v.settlement?.status === 'failed');

    const { body } = await call<GuestView>('POST', `/s/${link.token}/open`);
    expect(body.settlement!.id).not.toBe(failed.settlement!.id);
  });

  it('expires once the debt is settled another way', async () => {
    const { call, createLink, priyaOwesYash } = setup();
    const link = await createLink();
    const d = await priyaOwesYash();
    await call('POST', '/groups/g-flat/settlements/manual', { ...d, note: 'cash' });

    const { status, body } = await call<{ code: string }>('POST', `/s/${link.token}/open`);
    expect(status).toBe(410);
    expect(body.code).toBe('link_expired');
  });

  it('expires once the debt shrinks below the link', async () => {
    const { call, createLink, priyaOwesYash } = setup();
    const link = await createLink();
    const d = await priyaOwesYash();
    await call('POST', '/groups/g-flat/settlements/manual', { ...d, amount: 1 });

    const { status, body } = await call<{ code: string }>('POST', `/s/${link.token}/open`);
    expect(status).toBe(410);
    expect(body.code).toBe('link_expired');
  });

  it('refuses a payee with nowhere to receive', async () => {
    const { db, call, debt } = setup();
    // Links are only made by the payee, who is always joined; force a ghost to reach this branch.
    const d = await debt('g-goa', 'm-goa-yash', 'm-goa-aman');
    db.prepare(
      `INSERT INTO pay_links (token, group_id, from_member_id, to_member_id, amount, created_by_user_id, created_at)
       VALUES ('ghost', 'g-goa', ?, ?, ?, 'u-yash', ?)`
    ).run(d.fromMemberId, d.toMemberId, d.amount, new Date().toISOString());

    const { status, body } = await call<{ code: string }>('POST', '/s/ghost/open');
    expect(status).toBe(409);
    expect(body.code).toBe('member_cannot_receive');
  });

  it('refuses while the same debt is being paid outside the link', async () => {
    const { call, createLink, priyaOwesYash } = setup('stalled');
    const link = await createLink();
    const d = await priyaOwesYash();
    expect((await call('POST', '/groups/g-flat/settlements', { ...d, rail: 'invoice' })).status).toBe(201);

    const { status, body } = await call<{ code: string }>('POST', `/s/${link.token}/open`);
    expect(status).toBe(409);
    expect(body.code).toBe('conflict');
  });

  it('never lets two links for the same debt both collect', async () => {
    const { call, createLink, waitForGuest } = setup();
    const a = await createLink();
    const b = await createLink();
    expect(b.token).not.toBe(a.token);

    await call('POST', `/s/${a.token}/open`);
    const busy = await call<{ code: string }>('POST', `/s/${b.token}/open`);
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('conflict');

    await waitForGuest(a.token, (v) => v.settlement?.status === 'confirmed');
    const after = await call<{ code: string }>('POST', `/s/${b.token}/open`);
    expect(after.status).toBe(410);
    expect(after.body.code).toBe('link_expired');
  });

  it('replays a repeated idempotency key', async () => {
    const { call, createLink, settlementCount } = setup();
    const link = await createLink();
    const h = { 'idempotency-key': 'open-1' };
    const a = await call<GuestView>('POST', `/s/${link.token}/open`, undefined, h);
    const before = settlementCount();
    const b = await call<GuestView>('POST', `/s/${link.token}/open`, undefined, h);
    expect(b.body).toEqual(a.body);
    expect(settlementCount()).toBe(before);
  });
});

describe('GET /s/:token', () => {
  it('404s an unknown token', async () => {
    const { call } = setup();
    expect((await call('GET', '/s/nope')).status).toBe(404);
  });

  it('shows names and no settlement before the link is opened', async () => {
    const { call, createLink } = setup();
    const link = await createLink();
    const { status, body } = await call<GuestView>('GET', `/s/${link.token}`);
    expect(status).toBe(200);
    expect(body).toEqual({ payerName: 'Priya', payeeName: 'Yash', reason: 'Flat 4B' });
  });
});

describe('guest privacy', () => {
  const ids = [...fixtures.members.map((m) => m.id), ...fixtures.groups.map((g) => g.id)];

  it('never puts a member or group id in an /s/ response', async () => {
    const { call, createLink, waitForGuest } = setup();
    const link = await createLink();
    const responses = [
      await call('GET', `/s/${link.token}`),
      await call('POST', `/s/${link.token}/open`),
      await waitForGuest(link.token, (v) => v.settlement?.status === 'confirmed').then((body) => ({ body })),
      await call('POST', '/s/demo/open'),
      await call('GET', '/s/demo'),
    ];
    for (const { body } of responses) {
      const json = JSON.stringify(body);
      for (const id of ids) expect(json).not.toContain(id);
      expect(body).not.toHaveProperty('settlement.groupId');
      expect(body).not.toHaveProperty('settlement.fromMemberId');
      expect(body).not.toHaveProperty('settlement.toMemberId');
    }
  });
});
