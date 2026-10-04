/**
 * Each test pins a sentence on the app's trust screen (TrustModel in
 * apps/mobile/src/ui/WalletScreen.tsx). If one fails, the code changed what
 * a user is trusting: rewrite the sentence first, then this test.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Debt, Member, Settlement, UpiClaim, UpiPayee, User } from '@sattle/core';

import { createApp } from './app';
import { openDb, seedIfEmpty } from './db';
import type { NwcApi } from './nwc';
import { SimulatedPayments } from './payments';

const URI = `nostr+walletconnect://${'a'.repeat(64)}?relay=wss://relay.example&secret=${'b'.repeat(64)}`;

const receiveOnly = (): NwcApi => ({
  getInfo: async () => ({ alias: 'Test Hub', methods: ['get_info', 'make_invoice', 'lookup_invoice'] }),
  makeInvoice: async () => {
    throw new Error('not used here');
  },
  lookupInvoice: async () => {
    throw new Error('not used here');
  },
  close: () => {},
});

function setup() {
  const db = openDb(':memory:');
  seedIfEmpty(db);
  const app = createApp({
    db,
    demoUserId: 'u-yash',
    nwc: receiveOnly,
    payments: (repo) =>
      new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
  });
  async function call<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
  }
  return { db, call };
}

const source = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

describe('Your wallet connection', () => {
  it('"It asks only three things": every request the client sends is one of them', () => {
    const sent = [...source('./nwc.ts').matchAll(/this\.#request<[^(]*\('([a-z_]+)'/g)].map((m) => m[1]);
    expect(sent.sort()).toEqual(['get_info', 'lookup_invoice', 'make_invoice']);
  });

  it('"It has no code that spends": nothing that talks to a wallet names a paying method', () => {
    for (const file of ['./nwc.ts', './payments/lightning.ts', './lnurl.ts', './safeFetch.ts', './routes/wallet.ts']) {
      expect(source(file)).not.toMatch(/pay_invoice|pay_keysend/);
    }
  });

  it('"keeps the connection string, unencrypted"', async () => {
    const { db, call } = setup();
    expect((await call('PUT', '/me/wallet', { nwcUri: URI })).status).toBe(200);
    const row = db.prepare('SELECT nwc_uri FROM wallet_connections').get() as { nwc_uri: string };
    expect(row.nwc_uri).toBe(URI);
  });

  it('"Disconnect makes the server forget the string": the row is gone', async () => {
    const { db, call } = setup();
    const { token } = (await call<{ token: string }>('POST', '/accounts', { displayName: 'Riya' })).body;
    const as = { authorization: `Bearer ${token}` };
    await call('PUT', '/me/wallet', { nwcUri: URI }, as);
    expect((await call('DELETE', '/me/wallet', undefined, as)).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM wallet_connections').get()).toEqual({ n: 0 });
  });
});

describe('Your account', () => {
  it('"a name and a random key": that is all an account is made from', async () => {
    const { call } = setup();
    const res = await call<{ user: User; token: string }>('POST', '/accounts', {
      displayName: 'Riya',
      email: 'riya@example.com',
      phone: '+910000000000',
    });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body.user).sort()).toEqual(['displayName', 'id']);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await call<User>('GET', '/me', undefined, { authorization: `Bearer ${res.body.token}` })).body).toEqual(
      res.body.user
    );
  });
});

describe('Is it really paid?', () => {
  it('"the person who is owed marks it": Om can’t settle Priya’s debt to Yash by hand, Yash can', async () => {
    const { db, call } = setup();
    db.prepare("UPDATE users SET token = 't-om' WHERE id = 'u-om'").run();
    const asOm = { authorization: 'Bearer t-om' };

    const debt = (await call<Debt[]>('GET', '/groups/g-flat/debts', undefined, asOm)).body.find(
      (d) => d.fromMemberId === 'm-flat-priya' && d.toMemberId === 'm-flat-yash'
    )!;
    const body = { fromMemberId: debt.fromMemberId, toMemberId: debt.toMemberId, amount: debt.amount, note: 'cash' };
    expect((await call('POST', '/groups/g-flat/settlements/manual', body, asOm)).status).toBe(400);

    const res = await call<Settlement>('POST', '/groups/g-flat/settlements/manual', body);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('manually_confirmed');
    expect(res.body).not.toHaveProperty('preimage');
  });

  it('"or the person paying if the one owed hasn’t joined": Yash settles his debt to Aman by hand', async () => {
    const { call } = setup();
    const debt = (await call<Debt[]>('GET', '/groups/g-goa/debts')).body.find(
      (d) => d.fromMemberId === 'm-goa-yash' && d.toMemberId === 'm-goa-aman'
    )!;
    const res = await call<Settlement>('POST', '/groups/g-goa/settlements/manual', { ...debt, note: 'cash' });
    expect(res.status).toBe(201);
  });
});

describe('UPI', () => {
  const yashOwesOm = async (call: ReturnType<typeof setup>['call']) =>
    (await call<Debt[]>('GET', '/groups/g-goa/debts')).body.find(
      (d) => d.fromMemberId === 'm-goa-yash' && d.toMemberId === 'm-goa-om'
    )?.amount ?? 0;

  it('"the balance moves only when the person who is owed confirms it arrived": the payer’s word settles nothing, and he can’t confirm it himself', async () => {
    const { db, call } = setup();
    db.prepare("UPDATE users SET upi_id = 'om@okhdfcbank', token = 't-om' WHERE id = 'u-om'").run();
    const owed = await yashOwesOm(call);

    const claim = await call<UpiClaim>('POST', '/groups/g-goa/upi-claims', {
      fromMemberId: 'm-goa-yash',
      toMemberId: 'm-goa-om',
      amount: owed,
      reference: '412345678901',
    });
    expect(claim.status).toBe(201);
    expect(await yashOwesOm(call)).toBe(owed);
    expect((await call('POST', `/upi-claims/${claim.body.id}/confirm`)).status).toBe(400);
    expect(await yashOwesOm(call)).toBe(owed);

    const confirmed = await call<Settlement>('POST', `/upi-claims/${claim.body.id}/confirm`, undefined, {
      authorization: 'Bearer t-om',
    });
    expect(confirmed.body).toMatchObject({ rail: 'upi', status: 'manually_confirmed' });
    expect(confirmed.body).not.toHaveProperty('preimage');
    expect(await yashOwesOm(call)).toBe(0);
  });

  it('"only someone who owes you is shown it": Yash, who owes Om, is; the member list never carries it', async () => {
    const { db, call } = setup();
    db.prepare("UPDATE users SET upi_id = 'om@okhdfcbank', token = 't-om' WHERE id = 'u-om'").run();

    expect((await call<UpiPayee>('GET', '/groups/g-goa/members/m-goa-om/upi')).body).toEqual({ upiId: 'om@okhdfcbank', name: 'Om' });
    const members = await call<Member[]>('GET', '/groups/g-goa/members');
    expect(members.body.find((m) => m.id === 'm-goa-om')?.upi).toBe(true);
    expect(JSON.stringify(members.body)).not.toContain('okhdfcbank');

    // Yash's own, asked for by Om, who owes Yash nothing here.
    await call('PUT', '/me/upi', { upiId: 'yash@ybl' });
    const asOm = await call('GET', '/groups/g-goa/members/m-goa-yash/upi', undefined, { authorization: 'Bearer t-om' });
    expect(asOm.status).toBe(409);
    expect(JSON.stringify(asOm.body)).not.toContain('yash@ybl');
  });
});

describe('Your Lightning address', () => {
  it('"Sattle\'s server keeps it" and "Only you can set yours": each person sets their own, and no one else\'s', async () => {
    const { db, call } = setup();
    db.prepare("UPDATE users SET token = 't-om' WHERE id = 'u-om'").run();
    // Om sets his, as himself: there's no route that takes someone else's id.
    expect((await call('PUT', '/me/receive-address', { address: 'om@blink.sv' }, { authorization: 'Bearer t-om' })).status).toBe(200);
    const rows = db.prepare('SELECT id, receive_address FROM users ORDER BY id').all() as { id: string; receive_address: string | null }[];
    expect(rows.filter((r) => r.receive_address)).toEqual([{ id: 'u-om', receive_address: 'om@blink.sv' }]);
    expect((await call('PUT', '/users/u-yash/receive-address', { address: 'om@blink.sv' }, { authorization: 'Bearer t-om' })).status).toBe(404);
  });
});
