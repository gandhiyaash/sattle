/**
 * O3's pay links driving LightningPayments with a fake wallet: I1 and I2 in
 * everything but the real wallet.
 */
import { createHash, randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { fixtures, type Debt, type Group, type GuestView, type PayLink, type Settlement, type UpiClaim, type UpiPayee } from '@sattle/core';

import { createApp } from './app';
import { openDb, seedIfEmpty, type Db } from './db';
import type { NwcApi, NwcInvoice } from './nwc';
import { LightningPayments } from './payments/lightning';
import type { RateService } from './rates';

const URI = `nostr+walletconnect://${'a'.repeat(64)}?relay=wss://relay.example&secret=${'b'.repeat(64)}`;
const rates: RateService = { rate: async (currency) => ({ currency, rateFiatPerBtc: 8_000_000, source: 'live', provider: 'CoinGecko' }) };

let db: Db;
let backend: LightningPayments | undefined;
let minted: number;
let state: () => Partial<NwcInvoice>;
let now: number;

function fakeNwc(): NwcApi {
  return {
    getInfo: async () => ({ methods: ['get_info', 'make_invoice', 'lookup_invoice'] }),
    makeInvoice: async (p) => {
      minted++;
      const preimage = randomBytes(32).toString('hex');
      const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
      return { invoice: `lnbc${minted}real`, paymentHash, amountMsat: p.amountMsat, createdAt: 0, expiresAt: Math.floor(now / 1000) + (p.expirySec ?? 0), state: 'pending' };
    },
    lookupInvoice: async ({ paymentHash }: { paymentHash: string }) => ({ invoice: 'x', paymentHash, amountMsat: 1, createdAt: 0, state: 'pending', ...state() }),
    close: () => {},
  };
}

const as = (userId?: string) =>
  createApp({
    db,
    demoUserId: userId,
    nwc: fakeNwc,
    payments: (repo, wallets) => (backend ??= new LightningPayments({ db, repo, wallets, rates, nwc: fakeNwc, pollMs: 2, now: () => now })),
  });

async function call<T>(userId: string | undefined, method: string, path: string, body?: unknown) {
  const res = await as(userId).request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

async function guestUntil(token: string, ok: (v: GuestView) => boolean) {
  for (let i = 0; i < 300; i++) {
    const v = (await call<GuestView>(undefined, 'GET', `/s/${token}`)).body;
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('guest view never got there');
}

beforeEach(() => {
  db = openDb(':memory:');
  seedIfEmpty(db);
  db.prepare(`UPDATE settlements SET status = 'expired' WHERE id = 'demo'`).run();
  backend?.close();
  backend = undefined;
  minted = 0;
  state = () => ({ state: 'pending' });
  now = Date.now();
});

describe('pay link → real invoice → paid (I1/I2 with a fake wallet)', () => {
  it('works end to end once the payee has connected a wallet', async () => {
    expect((await call('u-yash', 'PUT', '/me/wallet', { nwcUri: URI })).status).toBe(200);
    const link = (await call<PayLink>('u-yash', 'POST', '/groups/g-flat/pay-links', { fromMemberId: 'm-flat-om', toMemberId: 'm-flat-yash', amount: 120_000 })).body;

    const opened = await call<GuestView>(undefined, 'POST', `/s/${link.token}/open`);
    expect(opened.status).toBe(200);
    const invoice = await guestUntil(link.token, (v) => v.settlement?.status === 'awaiting_payment');
    expect(invoice.settlement).toMatchObject({ destination: 'lnbc1real', quote: { amountSat: 15_000 } });

    state = () => ({ state: 'settled', settledAt: 1 });
    const paid = await guestUntil(link.token, (v) => v.settlement?.status === 'confirmed');
    expect(paid.settlement?.status).toBe('confirmed');

    // The group screen sees it too, and the debt is gone.
    const debts = (await call<{ fromMemberId: string; toMemberId: string }[]>('u-yash', 'GET', '/groups/g-flat/debts')).body;
    expect(debts.find((d) => d.fromMemberId === 'm-flat-om' && d.toMemberId === 'm-flat-yash')).toBeUndefined();
  });

  it('a lapsed invoice gets a fresh one on reopen, and the old one is closed', async () => {
    await call('u-yash', 'PUT', '/me/wallet', { nwcUri: URI });
    const link = (await call<PayLink>('u-yash', 'POST', '/groups/g-flat/pay-links', { fromMemberId: 'm-flat-om', toMemberId: 'm-flat-yash', amount: 120_000 })).body;
    await call(undefined, 'POST', `/s/${link.token}/open`);
    const first = await guestUntil(link.token, (v) => v.settlement?.status === 'awaiting_payment');

    // The quote lapses; the wallet agrees the invoice is dead.
    db.prepare(`UPDATE settlements SET quote = json_set(quote, '$.expiresAt', '2000-01-01T00:00:00.000Z') WHERE id = ?`).run(first.settlement!.id);
    state = () => ({ state: 'expired' });
    await call(undefined, 'POST', `/s/${link.token}/open`);
    const second = await guestUntil(link.token, (v) => v.settlement?.status === 'awaiting_payment' && v.settlement.id !== first.settlement!.id);
    expect(second.settlement?.destination).toBe('lnbc2real');
    // The old invoice is closed once the wallet says it's dead.
    for (let i = 0; i < 100; i++) {
      const old = db.prepare('SELECT status FROM settlements WHERE id = ?').get(first.settlement!.id) as { status: string };
      if (old.status === 'expired') break;
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(db.prepare('SELECT status FROM settlements WHERE id = ?').get(first.settlement!.id)).toEqual({ status: 'expired' });
  });

  it('payee without a wallet: refuses to make the link, rather than letting the guest find out', async () => {
    const made = await call<{ code: string; message: string }>('u-yash', 'POST', '/groups/g-flat/pay-links', { fromMemberId: 'm-flat-om', toMemberId: 'm-flat-yash', amount: 120_000 });
    expect(made.status).toBe(409);
    expect(made.body).toMatchObject({ code: 'member_cannot_receive', message: expect.stringContaining('Add a way to get paid first') });
  });
});

/**
 * The same link, paid by UPI. Under real payments someone with no wallet can't
 * be paid over Lightning, so every mix of the two ways can be set up here:
 * Om owes Yash ₹1,200 in Flat 4B, which is kept in rupees.
 */
describe('a pay link paid by UPI', () => {
  type Err = { code?: string; message?: string };
  const OM_OWES_YASH = { fromMemberId: 'm-flat-om', toMemberId: 'm-flat-yash', amount: 120_000 };

  const addUpi = () => call('u-yash', 'PUT', '/me/upi', { upiId: 'yash@okaxis' });
  const addWallet = () => call('u-yash', 'PUT', '/me/wallet', { nwcUri: URI });
  const makeLink = (amount = OM_OWES_YASH.amount) =>
    call<PayLink & Err>('u-yash', 'POST', '/groups/g-flat/pay-links', { ...OM_OWES_YASH, amount });
  const open = (token: string, body?: unknown) => call<GuestView & Err>(undefined, 'POST', `/s/${token}/open`, body);
  const view = async (token: string) => (await call<GuestView>(undefined, 'GET', `/s/${token}`)).body;
  const sayPaid = (token: string) => call<Err>(undefined, 'POST', `/s/${token}/upi-claims`);
  const claims = async () => (await call<UpiClaim[]>('u-yash', 'GET', '/groups/g-flat/upi-claims')).body;
  const omOwes = async () =>
    (await call<Debt[]>('u-yash', 'GET', '/groups/g-flat/debts')).body.find((d) => d.fromMemberId === 'm-flat-om')?.amount ?? 0;
  const invoicesFor = (token: string) =>
    (db.prepare('SELECT COUNT(*) AS n FROM settlements WHERE pay_link_token = ?').get(token) as { n: number }).n;

  it('won’t make a link nobody could pay, and says what to add', async () => {
    const none = await makeLink();
    expect(none.status).toBe(409);
    expect(none.body).toEqual({
      code: 'member_cannot_receive',
      message:
        'Add a way to get paid first, from Wallet: a UPI ID, a Lightning wallet or a Lightning address. Then the link has somewhere to send the money.',
    });

    // UPI is for rupees. In a group kept in bitcoin a UPI ID is no way to be paid, so it isn't what to add.
    await addUpi();
    const sats = (await call<Group>('u-yash', 'POST', '/groups', { name: 'Meetup', currency: 'BTC', memberNames: ['Riya'] })).body;
    const [me, riya] = sats.memberIds;
    await call('u-yash', 'POST', `/groups/${sats.id}/expenses`, {
      description: 'Pizza', amount: 20_000, paidByMemberId: me, splitMode: 'equal', parts: [{ memberId: me }, { memberId: riya }],
    });
    const inSats = await call<Err>('u-yash', 'POST', `/groups/${sats.id}/pay-links`, { fromMemberId: riya, toMemberId: me, amount: 10_000 });
    expect(inSats.status).toBe(409);
    expect(inSats.body.message).toBe(
      'Add a way to get paid first, from Wallet: a Lightning wallet or a Lightning address. Then the link has somewhere to send the money.'
    );
  });

  it('makes one for someone who only takes UPI, and mints no invoice for it', async () => {
    await addUpi();
    const link = await makeLink();
    expect(link.status).toBe(201);

    const opened = await open(link.body.token);
    expect(opened.status).toBe(200);
    expect(opened.body).toEqual({
      payerName: 'Om', payeeName: 'Yash', reason: 'Flat 4B', amount: 120_000, currency: 'INR', payable: false, upi: true,
    });
    expect(minted).toBe(0);
    expect(invoicesFor(link.body.token)).toBe(0);

    // Asking for Lightning anyway is refused, not left to fail on the wallet.
    const lightning = await open(link.body.token, { rail: 'lightning' });
    expect(lightning.status).toBe(409);
    expect(lightning.body.code).toBe('member_cannot_receive');
  });

  it('gives the UPI ID only to someone who asks to pay', async () => {
    await addUpi();
    const { token } = (await makeLink()).body;
    expect(JSON.stringify(await view(token))).not.toContain('yash@okaxis');
    expect((await call<UpiPayee>(undefined, 'GET', `/s/${token}/upi`)).body).toEqual({ upiId: 'yash@okaxis', name: 'Yash' });
  });

  it('asks before minting when it can be paid both ways, and mints once Lightning is chosen', async () => {
    await addUpi();
    await addWallet();
    const { token } = (await makeLink()).body;

    const asked = await open(token);
    expect(asked.body).toMatchObject({ payable: true, upi: true });
    expect(asked.body.settlement).toBeUndefined();
    expect(minted).toBe(0);

    expect((await open(token, { rail: 'lightning' })).status).toBe(200);
    const invoice = await guestUntil(token, (v) => v.settlement?.status === 'awaiting_payment');
    expect(invoice.settlement?.destination).toBe('lnbc1real');

    // With that invoice out, UPI waits: one of the two could otherwise pay it twice.
    const both = await sayPaid(token);
    expect(both.status).toBe(409);
    expect(both.body.code).toBe('conflict');
    // And opening it again shows the invoice, whatever is or isn't chosen.
    expect((await open(token)).body.settlement?.id).toBe(invoice.settlement?.id);
    expect(minted).toBe(1);
  });

  it('opens straight on the invoice, as before, for someone with a wallet and no UPI ID', async () => {
    await addWallet();
    const { token } = (await makeLink()).body;
    const opened = await open(token);
    expect(opened.body.upi).toBeUndefined();
    expect(opened.body.settlement).toBeDefined();
  });

  it('lets the page say it was paid; the person owed confirms, and the link shows it paid for good', async () => {
    await addUpi();
    const { token } = (await makeLink()).body;

    expect((await sayPaid(token)).status).toBe(201);
    expect((await view(token)).upiClaim).toBe('pending');
    // A claim moves nothing.
    expect(await omOwes()).toBe(120_000);
    const [made] = await claims();
    expect(made).toMatchObject({ ...OM_OWES_YASH, status: 'pending', viaLink: true });

    // Saying it again, or opening the link again, changes nothing while Yash hasn't answered.
    expect((await sayPaid(token)).status).toBe(201);
    expect((await claims()).map((c) => c.id)).toEqual([made.id]);
    expect((await open(token)).body).toMatchObject({ upiClaim: 'pending' });

    const settled = (await call<Settlement>('u-yash', 'POST', `/upi-claims/${made.id}/confirm`)).body;
    expect(settled).toMatchObject({ rail: 'upi', status: 'manually_confirmed', amount: 120_000 });
    expect(await omOwes()).toBe(0);

    // The page now has a payment to show, where a debt that was merely gone would be "nothing to pay".
    const paid = await open(token);
    expect(paid.status).toBe(200);
    expect(paid.body.settlement).toMatchObject({ id: settled.id, status: 'manually_confirmed' });
    expect(paid.body.upiClaim).toBeUndefined();
    expect((await sayPaid(token)).status).toBe(410);
    expect((await call(undefined, 'GET', `/s/${token}/upi`)).status).toBe(410);
    expect(minted).toBe(0);
  });

  it('pays once, even when as much again is still owed', async () => {
    await addUpi();
    const { token } = (await makeLink(50_000)).body;
    await sayPaid(token);
    await call('u-yash', 'POST', `/upi-claims/${(await claims())[0].id}/confirm`);
    expect(await omOwes()).toBe(70_000);

    expect((await sayPaid(token)).status).toBe(410);
    expect((await claims())).toEqual([]);
    expect((await open(token)).body.settlement?.status).toBe('manually_confirmed');
  });

  it('shows the person owed turning it down, and lets the page say so again', async () => {
    await addUpi();
    const { token } = (await makeLink()).body;
    await sayPaid(token);
    await call('u-yash', 'POST', `/upi-claims/${(await claims())[0].id}/decline`);
    expect((await open(token)).body).toMatchObject({ upiClaim: 'declined', upi: true });

    expect((await sayPaid(token)).status).toBe(201);
    expect((await view(token)).upiClaim).toBe('pending');
  });

  it('leaves what the payer said in the app as it is', async () => {
    await addUpi();
    const { token } = (await makeLink()).body;
    const theirs = (await call<UpiClaim>('u-om', 'POST', '/groups/g-flat/upi-claims', { ...OM_OWES_YASH, reference: 'UPI123' })).body;

    expect((await sayPaid(token)).status).toBe(201);
    expect(await claims()).toEqual([theirs]);
  });

  it('stops offering UPI once it is turned off for shared links, and says so to whoever asks for a link', async () => {
    await addUpi();
    const { token } = (await makeLink()).body;
    await call('u-yash', 'PUT', '/me/upi/group-links', { on: false });

    // No wallet either: the link they already sent can't be paid, and a new one isn't made.
    expect((await open(token)).status).toBe(409);
    expect((await call(undefined, 'GET', `/s/${token}/upi`)).status).toBe(409);
    expect((await sayPaid(token)).status).toBe(409);
    const again = await makeLink();
    expect(again.status).toBe(409);
    expect(again.body.message).toBe(
      'Your UPI ID is turned off for shared links here, and you have no Lightning wallet, so nobody could pay this link. Turn it back on, or add a wallet.'
    );

    // With a wallet it is a Lightning link, and opens on the invoice.
    await addWallet();
    const opened = await open(token);
    expect(opened.body).toMatchObject({ payable: true });
    expect(opened.body.upi).toBeUndefined();
    expect(opened.body.settlement).toBeDefined();
  });

  it('never puts a member or group id in what the page is sent', async () => {
    await addUpi();
    const { token } = (await makeLink()).body;
    const ids = [...fixtures.members.map((m) => m.id), ...fixtures.groups.map((g) => g.id)];
    const sent = [
      await open(token),
      await call(undefined, 'GET', `/s/${token}/upi`),
      await sayPaid(token),
      await call(undefined, 'GET', `/s/${token}`),
    ];
    for (const { body } of sent) {
      for (const id of ids) expect(JSON.stringify(body)).not.toContain(id);
    }
  });
});
