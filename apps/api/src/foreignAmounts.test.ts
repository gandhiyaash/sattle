/**
 * Expenses paid in another currency than the group's: the conversion rate
 * the app asks for, and the original kept beside what everyone owes.
 */

import { describe, expect, it } from 'vitest';

import type { ConversionRate, Expense, Group, User } from '@sattle/core';

import { createApp } from './app';
import { openDb } from './db';
import { SimulatedPayments } from './payments';
import type { RateService } from './rates';

/** A bitcoin is ₹88,00,000, $1,00,000 or ฿32,00,000. */
const PRICES: Record<string, number> = { INR: 8_800_000, USD: 100_000, THB: 3_200_000 };

const fakeRates: RateService = {
  async rate(currency) {
    const price = PRICES[currency];
    if (!price) throw new Error(`no price for ${currency}`);
    return { currency, rateFiatPerBtc: price, source: 'live', provider: 'Test', fetchedAt: '2026-10-28T00:00:00.000Z' };
  },
};

async function setup(rates: RateService | null = fakeRates) {
  const db = openDb(':memory:');
  const app = createApp({
    db,
    rates: rates ?? undefined,
    payments: (repo) =>
      new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
  });
  async function call<T = unknown>(method: string, path: string, body?: unknown, token?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as T };
  }
  const { token } = (await call<{ user: User; token: string }>('POST', '/accounts', { displayName: 'Riya' })).body;
  const group = (await call<Group>('POST', '/groups', { name: 'Bangkok', memberNames: ['Kabir'] }, token)).body;
  const base = `/groups/${group.id}`;
  const expense = (amount: number, original?: unknown) => ({
    description: 'Tuk-tuk',
    amount,
    paidByMemberId: group.memberIds[0],
    splitMode: 'equal',
    parts: group.memberIds.map((memberId) => ({ memberId })),
    ...(original ? { original } : {}),
  });
  return { call, token, group, base, expense };
}

describe('GET /rates/convert', () => {
  it('prices a baht in paise through each one’s price of a bitcoin', async () => {
    const { call, token } = await setup();
    const res = await call<ConversionRate>('GET', '/rates/convert?from=thb&to=INR', undefined, token);
    expect(res.status).toBe(200);
    // ₹88,00,000 / ฿32,00,000 is ₹2.75 a baht.
    expect(res.body).toMatchObject({ from: 'THB', to: 'INR', rate: 275, provider: 'Test' });
  });

  it('prices a dollar in sats for a group kept in bitcoin', async () => {
    const { call, token } = await setup();
    const res = await call<ConversionRate>('GET', '/rates/convert?from=USD&to=BTC', undefined, token);
    expect(res.body.rate).toBe(1_000);
  });

  it('says so when no source can price the currency', async () => {
    const { call, token } = await setup();
    const res = await call<{ code: string }>('GET', '/rates/convert?from=JPY&to=INR', undefined, token);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('network');
  });

  it('says so on a server with no prices at all', async () => {
    const { call, token } = await setup(null);
    const res = await call<{ code: string }>('GET', '/rates/convert?from=USD&to=INR', undefined, token);
    expect(res.status).toBe(503);
  });
});

describe('an expense paid in another currency', () => {
  it('keeps what was paid beside what everyone owes', async () => {
    const { call, token, base, expense } = await setup();
    // ฿400 at ₹2.75 is ₹1,100.
    const original = { currency: 'THB', amount: 40_000, rate: 275 };
    const added = await call<Expense>('POST', `${base}/expenses`, expense(110_000, original), token);
    expect(added.status).toBe(201);
    expect(added.body.original).toEqual(original);
    const [read] = (await call<Expense[]>('GET', `${base}/expenses`, undefined, token)).body;
    expect(read.original).toEqual(original);
    expect(read.amount).toBe(110_000);
  });

  it('refuses an amount that isn’t what was paid at that rate', async () => {
    const { call, token, base, expense } = await setup();
    const res = await call<{ code: string }>(
      'POST', `${base}/expenses`, expense(120_000, { currency: 'THB', amount: 40_000, rate: 275 }), token
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_expense');
  });

  it('refuses the group’s own currency as a foreign one', async () => {
    const { call, token, base, expense } = await setup();
    const res = await call('POST', `${base}/expenses`, expense(10_000, { currency: 'INR', amount: 10_000, rate: 100 }), token);
    expect(res.status).toBe(400);
  });

  it('drops the original when it’s changed back to rupees', async () => {
    const { call, token, base, expense } = await setup();
    const added = (
      await call<Expense>('POST', `${base}/expenses`, expense(110_000, { currency: 'THB', amount: 40_000, rate: 275 }), token)
    ).body;
    const changed = await call<Expense>('PUT', `${base}/expenses/${added.id}`, expense(100_000), token);
    expect(changed.status).toBe(200);
    expect(changed.body.original).toBeUndefined();
    const [read] = (await call<Expense[]>('GET', `${base}/expenses`, undefined, token)).body;
    expect(read.original).toBeUndefined();
  });

  it('counts a changed rate as a change', async () => {
    const { call, token, base, expense } = await setup();
    const added = (
      await call<Expense>('POST', `${base}/expenses`, expense(110_000, { currency: 'THB', amount: 40_000, rate: 275 }), token)
    ).body;
    const changed = (
      await call<Expense>('PUT', `${base}/expenses/${added.id}`, expense(112_000, { currency: 'THB', amount: 40_000, rate: 280 }), token)
    ).body;
    expect(changed.original?.rate).toBe(280);
  });
});
