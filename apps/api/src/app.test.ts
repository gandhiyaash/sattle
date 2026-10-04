import { beforeEach, describe, expect, it } from 'vitest';

import type { Debt, Expense, Member, Settlement } from '@sattle/core';

import { createApp } from './app';
import { openDb, seedIfEmpty, type Db } from './db';
import { SimulatedPayments } from './payments';

let db: Db;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(':memory:');
  seedIfEmpty(db);
  app = createApp({
    db,
    demoUserId: 'u-yash',
    payments: (repo) =>
      new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
  });
});

async function call<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T, headers: res.headers };
}

const waitFor = async <T>(fn: () => Promise<T>, ok: (v: T) => boolean) => {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out');
};

describe('reads', () => {
  it('only lists groups the user belongs to', async () => {
    db.prepare("INSERT INTO expense_groups (id, name, currency, created_at) VALUES ('g-secret', 'Not yours', 'INR', '2026-01-01')").run();
    const { body } = await call<{ id: string }[]>('GET', '/groups');
    expect(body.map((g) => g.id).sort()).toEqual(['g-flat', 'g-goa']);
    expect((await call('GET', '/groups/g-secret')).status).toBe(404);
  });

  it('returns members in group order without null fields', async () => {
    const { body } = await call<Member[]>('GET', '/groups/g-goa/members');
    expect(body.map((m) => m.id)).toEqual(['m-goa-yash', 'm-goa-om', 'm-goa-aman', 'm-goa-priya']);
    expect(body[2]).not.toHaveProperty('lightningAddress');
  });

  it('nets debts with the shared ledger', async () => {
    const { body } = await call<Debt[]>('GET', '/groups/g-goa/debts');
    expect(body.reduce((a, d) => a + d.amount, 0)).toBeGreaterThan(0);
    expect(body.find((d) => d.fromMemberId === 'm-goa-yash')).toBeDefined();
  });

  it('rejects an unknown bearer token even when a demo user is set', async () => {
    expect((await call('GET', '/me', undefined, { authorization: 'Bearer nope' })).status).toBe(401);
  });
});

describe('expenses', () => {
  const lunch = {
    description: 'Lunch',
    amount: 1001,
    paidByMemberId: 'm-flat-yash',
    splitMode: 'equal',
    parts: [{ memberId: 'm-flat-yash' }, { memberId: 'm-flat-om' }, { memberId: 'm-flat-priya' }],
  };

  it('resolves parts so they sum exactly', async () => {
    const { status, body } = await call<Expense>('POST', '/groups/g-flat/expenses', lunch);
    expect(status).toBe(201);
    expect(body.parts.map((p) => p.amount)).toEqual([334, 334, 333]);
  });

  it('rejects members from another group', async () => {
    const { status, body } = await call<{ code: string }>('POST', '/groups/g-flat/expenses', {
      ...lunch,
      paidByMemberId: 'm-goa-om',
    });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_expense');
  });

  it('replays the first response for a repeated idempotency key', async () => {
    const h = { 'idempotency-key': 'k1' };
    const a = await call<Expense>('POST', '/groups/g-flat/expenses', lunch, h);
    const b = await call<Expense>('POST', '/groups/g-flat/expenses', lunch, h);
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers.get('idempotent-replay')).toBe('true');
    const { body } = await call<Expense[]>('GET', '/groups/g-flat/expenses');
    expect(body.filter((e) => e.description === 'Lunch')).toHaveLength(1);
  });
});

describe('settlements', () => {
  const owedToOm = async () =>
    (await call<Debt[]>('GET', '/groups/g-goa/debts')).body.find(
      (d) => d.fromMemberId === 'm-goa-yash' && d.toMemberId === 'm-goa-om'
    )!;

  it('walks to confirmed and only then moves the ledger', async () => {
    const debt = await owedToOm();
    const { status, body } = await call<Settlement>('POST', '/groups/g-goa/settlements', { ...debt, rail: 'invoice' });
    expect(status).toBe(201);
    expect(body.status).toBe('created');

    const done = await waitFor(
      () => call<Settlement>('GET', `/settlements/${body.id}`).then((r) => r.body),
      (s) => s.status === 'confirmed'
    );
    expect(done.preimage).toMatch(/^[0-9a-f]{64}$/);
    expect(done.quote?.amountSat).toBeGreaterThan(0);
    expect(await owedToOm()).toBeUndefined();
  });

  it('refuses a ghost with nowhere to receive', async () => {
    const debt = (await call<Debt[]>('GET', '/groups/g-goa/debts')).body.find((d) => d.toMemberId === 'm-goa-aman')!;
    const { status, body } = await call<{ code: string }>('POST', '/groups/g-goa/settlements', { ...debt, rail: 'invoice' });
    expect(status).toBe(409);
    expect(body.code).toBe('member_cannot_receive');
  });

  it('refuses more than is owed', async () => {
    const debt = await owedToOm();
    const { status } = await call('POST', '/groups/g-goa/settlements', { ...debt, amount: debt.amount + 1, rail: 'invoice' });
    expect(status).toBe(409);
  });

  it('refuses a second payment while one is in progress', async () => {
    const debt = await owedToOm();
    await call('POST', '/groups/g-goa/settlements', { ...debt, rail: 'invoice' });
    const { status, body } = await call<{ code: string }>('POST', '/groups/g-goa/settlements', { ...debt, rail: 'invoice' });
    expect(status).toBe(409);
    expect(body.code).toBe('conflict');
  });

  it('records a manual settlement immediately', async () => {
    const debt = await owedToOm();
    const { body } = await call<Settlement>('POST', '/groups/g-goa/settlements/manual', { ...debt, note: 'cash' });
    expect(body.status).toBe('manually_confirmed');
    expect(await owedToOm()).toBeUndefined();
  });
});

describe('payout address', () => {
  it('rejects an invoice and keeps a ghost a ghost', async () => {
    const bad = await call<{ code: string }>('PUT', '/members/m-goa-aman/payout-address', { address: 'lnbc10u1abc' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_address');

    const ok = await call<Member>('PUT', '/members/m-goa-aman/payout-address', { address: 'Aman@WalletOfSatoshi.com' });
    expect(ok.body).toMatchObject({ lightningAddress: 'aman@walletofsatoshi.com', status: 'ghost' });
  });
});
