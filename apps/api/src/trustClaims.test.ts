/**
 * Each test pins a sentence on the app's trust screen (TrustModel in
 * apps/mobile/src/ui/WalletScreen.tsx). If one fails, the code changed what
 * a user is trusting: rewrite the sentence first, then this test.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Debt, GroupGuestView, Member, Settlement, UpiClaim, UpiPayee, User } from '@sattle/core';

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

  it('"someone in the group who owes you is shown it": Yash, who owes Om, is; the member list never carries it', async () => {
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

describe('UPI on shared links', () => {
  /** Yash, the demo user, is owed in Flat 4B, which is shared at /g/demo-group. He adds a UPI ID. */
  async function owed() {
    const t = setup();
    await t.call('PUT', '/me/upi', { upiId: 'yash@ybl' });
    const page = async () => (await t.call<GroupGuestView>('GET', '/g/demo-group')).body;
    const debt = async () => (await page()).debts.find((d) => d.to === 'Yash')!;
    const id = async () => t.call<UpiPayee>('GET', `/g/demo-group/debts/${(await debt()).ref}/upi`);
    return { ...t, page, debt, id };
  }

  it('"So is anyone holding one of your groups\' shared links, when they choose to pay you": from the start, and the ID only for the debt they pick', async () => {
    const { page, debt, id } = await owed();
    expect((await debt()).upi).toBe(true);
    expect(JSON.stringify(await page())).not.toContain('yash@ybl');
    expect((await id()).body).toEqual({ upiId: 'yash@ybl', name: 'Yash' });
  });

  it('"unless you turn that off, for all your groups or for one"', async () => {
    const { call, debt, id } = await owed();

    await call('PUT', '/me/upi/group-links/g-flat', { on: false });
    expect((await debt()).upi).toBeUndefined();
    expect((await id()).status).toBe(409);

    await call('PUT', '/me/upi/group-links/g-flat', { on: null });
    expect((await id()).status).toBe(200);
    await call('PUT', '/me/upi/group-links', { on: false });
    expect((await debt()).upi).toBeUndefined();
    expect((await id()).status).toBe(409);
  });
});

describe('Group links', () => {
  it('"A group has no link until someone in it makes one"', async () => {
    const { call } = setup();
    expect((await call('GET', '/groups/g-goa/link')).body).toBeNull();
    const made = await call<{ token: string }>('POST', '/groups/g-goa/link');
    expect((await call('GET', `/g/${made.body.token}`)).status).toBe(200);
  });

  it('"sees every expense, each person’s share, everyone’s name and who owes whom"', async () => {
    const { call } = setup();
    const view = (await call<GroupGuestView>('GET', '/g/demo-group')).body;
    expect(Object.keys(view).sort()).toEqual(['currency', 'debts', 'expenses', 'groupName']);
    expect(Object.keys(view.expenses[0]).sort()).toEqual(['amount', 'createdAt', 'description', 'paidBy', 'shares']);
    expect(Object.keys(view.debts[0]).sort()).toEqual(['amount', 'from', 'payable', 'ref', 'to']);
    const names = new Set(view.expenses.flatMap((e) => e.shares.map((sh) => sh.name)));
    expect([...names].sort()).toEqual(['Om', 'Priya', 'Yash']);
  });

  it('"and can pay a debt. They can’t change anything": the link reads, and starts a payment, nothing else', async () => {
    const { db, call } = setup();
    const before = JSON.stringify(db.prepare('SELECT * FROM expenses ORDER BY id').all());
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect((await call(method, '/g/demo-group', { name: 'Mine now' })).status).toBe(404);
    }
    expect((await call('POST', '/g/demo-group/expenses', { description: 'x', amount: 1 })).status).toBe(404);
    expect(JSON.stringify(db.prepare('SELECT * FROM expenses ORDER BY id').all())).toBe(before);

    const view = (await call<GroupGuestView>('GET', '/g/demo-group')).body;
    const debt = view.debts.find((d) => d.from === 'Priya')!;
    expect((await call('POST', `/g/demo-group/debts/${debt.ref}/pay-link`)).status).toBe(201);
  });

  it('"anyone in the group can replace it or turn it off"', async () => {
    const { db, call } = setup();
    db.prepare("UPDATE users SET token = 't-om' WHERE id = 'u-om'").run();
    const asOm = { authorization: 'Bearer t-om' };

    const replaced = await call<{ token: string }>('POST', '/groups/g-flat/link', undefined, asOm);
    expect((await call('GET', '/g/demo-group')).status).toBe(404);
    expect((await call('GET', `/g/${replaced.body.token}`)).status).toBe(200);

    expect((await call('DELETE', '/groups/g-flat/link', undefined, asOm)).status).toBe(200);
    expect((await call('GET', `/g/${replaced.body.token}`)).status).toBe(404);
  });
});

describe('Joining', () => {
  it('"The group link lets someone ask to join, not join. Someone already in the group has to let them in"', async () => {
    const { call } = setup();
    // Dev has Flat 4B's link and an account. The group isn't his until someone in it says so.
    const dev = (await call<{ token: string }>('POST', '/accounts', { displayName: 'Dev' })).body.token;
    const asDev = { authorization: `Bearer ${dev}` };
    const asked = await call<{ id: string; code: string }>('POST', '/join-requests', { token: 'demo-group', displayName: 'Dev' }, asDev);
    expect(asked.status).toBe(201);
    expect(asked.body.code).toMatch(/^\d{4}$/);
    expect((await call('GET', '/groups/g-flat', undefined, asDev)).status).toBe(404);

    // He can't let himself in. Yash, who is in the group, can.
    expect((await call('POST', `/join-requests/${asked.body.id}/approve`, undefined, asDev)).status).toBe(404);
    expect((await call('POST', `/join-requests/${asked.body.id}/approve`)).status).toBe(200);
    expect((await call('GET', '/groups/g-flat', undefined, asDev)).status).toBe(200);
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

describe('The exchange rate', () => {
  it('"A group kept in bitcoin is owed in sats already, so it is paid as it stands and no rate is used"', async () => {
    const { db, call } = setup();
    db.prepare(`UPDATE expense_groups SET currency = 'BTC' WHERE id = 'g-flat'`).run();
    // The seeded demo link's invoice is already open for Om → Yash.
    db.prepare(`UPDATE settlements SET status = 'expired' WHERE id = 'demo'`).run();
    db.prepare(`UPDATE users SET token = 't-om' WHERE id = 'u-om'`).run();
    const asOm = { authorization: 'Bearer t-om' };

    const created = await call<Settlement>(
      'POST',
      '/groups/g-flat/settlements',
      { fromMemberId: 'm-flat-om', toMemberId: 'm-flat-yash', amount: 15_000, rail: 'invoice' },
      asOm
    );
    expect(created.status).toBe(201);

    let s = created.body;
    for (let i = 0; i < 200 && !s.quote; i++) {
      await new Promise((r) => setTimeout(r, 2));
      s = (await call<Settlement>('GET', `/settlements/${s.id}`, undefined, asOm)).body;
    }
    // Read as paise at the server's rupee rate, 15,000 would have come to 1,667 sats.
    expect(s.quote).toMatchObject({ amountFiat: 15_000, amountSat: 15_000, rateFiatPerBtc: 1 });
  });
});
