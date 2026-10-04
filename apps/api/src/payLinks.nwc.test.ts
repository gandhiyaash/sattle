/**
 * O3's pay links driving LightningPayments with a fake wallet: I1 and I2 in
 * everything but the real wallet.
 */
import { createHash, randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import type { GuestView, PayLink } from '@sattle/core';

import { createApp } from './app';
import { openDb, seedIfEmpty, type Db } from './db';
import type { NwcApi, NwcInvoice } from './nwc';
import { LightningPayments } from './payments/lightning';
import type { RateService } from './rates';

const URI = `nostr+walletconnect://${'a'.repeat(64)}?relay=wss://relay.example&secret=${'b'.repeat(64)}`;
const rates: RateService = { rate: async (currency) => ({ currency, rateFiatPerBtc: 8_000_000, source: 'live' }) };

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

  it('payee without a wallet: the guest gets a failed payment (known gap — should be member_cannot_receive up front)', async () => {
    const link = (await call<PayLink>('u-yash', 'POST', '/groups/g-flat/pay-links', { fromMemberId: 'm-flat-om', toMemberId: 'm-flat-yash', amount: 120_000 })).body;
    const opened = await call<GuestView>(undefined, 'POST', `/s/${link.token}/open`);
    const v = await guestUntil(link.token, (g) => g.settlement?.status === 'failed');
    // Today: 200 on open, then failed with a reason. Change both lines when the gap is fixed.
    expect(opened.status).toBe(200);
    expect(v.settlement?.failureReason).toContain('hasn’t connected a wallet');
  });
});
