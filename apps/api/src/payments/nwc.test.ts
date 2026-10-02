import { beforeEach, describe, expect, it } from 'vitest';

import type { Settlement } from '@sattle/core';

import { createApp } from '../app';
import { openDb, seedIfEmpty, type Db } from '../db';
import { NwcError, type MakeInvoiceParams, type NwcApi } from '../nwc';
import type { RateService } from '../rates';
import { NwcPayments } from './nwc';

const URI = `nostr+walletconnect://${'a'.repeat(64)}?relay=wss://relay.example&secret=${'b'.repeat(64)}`;
const HASH = 'd'.repeat(64);
const NOW = Date.parse('2026-10-02T10:00:00Z');

let db: Db;
let minted: MakeInvoiceParams[];
let mintError: Error | undefined;
let opened: number;
let backend: NwcPayments | undefined;

const rates: RateService = { rate: async (currency) => ({ currency, rateFiatPerBtc: 8_000_000, source: 'live' }) };

function fakeNwc(): NwcApi {
  opened++;
  return {
    getInfo: async () => ({ methods: ['get_info', 'make_invoice', 'lookup_invoice'] }),
    makeInvoice: async (p) => {
      if (mintError) throw mintError;
      minted.push(p);
      return { invoice: 'lnbc1real', paymentHash: HASH, amountMsat: p.amountMsat, createdAt: NOW / 1000, state: 'pending' };
    },
    lookupInvoice: async () => {
      throw new Error('not used in Y4');
    },
    close: () => {},
  };
}

/** An app acting as `userId`, all sharing one database and one payment backend. */
function as(userId: string) {
  return createApp({
    db,
    demoUserId: userId,
    nwc: fakeNwc,
    // One backend per test, like the one the server builds at boot.
    payments: (repo, wallets) => (backend ??= new NwcPayments({ db, repo, wallets, rates, nwc: fakeNwc, now: () => NOW })),
  });
}

async function call<T = unknown>(userId: string, method: string, path: string, body?: unknown) {
  const res = await as(userId).request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function settled(id: string) {
  for (let i = 0; i < 100; i++) {
    const s = (await call<Settlement>('u-om', 'GET', `/settlements/${id}`)).body;
    if (s.status !== 'created') return s;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('still created');
}

/** Om pays Yash ₹1,200 in Flat 4B. */
const omPaysYash = (rail = 'invoice', amount = 120_000) =>
  call<Settlement>('u-om', 'POST', '/groups/g-flat/settlements', {
    fromMemberId: 'm-flat-om',
    toMemberId: 'm-flat-yash',
    amount,
    rail,
  });

beforeEach(() => {
  db = openDb(':memory:');
  seedIfEmpty(db);
  // The seeded demo link's invoice is already open for Om → Yash.
  db.prepare(`UPDATE settlements SET status = 'expired' WHERE id = 'demo'`).run();
  minted = [];
  mintError = undefined;
  opened = 0;
  backend = undefined;
});

describe('NwcPayments', () => {
  beforeEach(async () => {
    expect((await call('u-yash', 'PUT', '/me/wallet', { nwcUri: URI })).status).toBe(200);
  });

  it('mints an invoice on the payee’s wallet and waits for payment', async () => {
    const created = await omPaysYash();
    expect(created.status).toBe(201);

    const s = await settled(created.body.id);
    expect(s).toMatchObject({ status: 'awaiting_payment', destination: 'lnbc1real' });
    // ₹1,200 at ₹80,00,000/BTC = 15,000 sats.
    expect(s.quote).toMatchObject({ amountFiat: 120_000, amountSat: 15_000, rateFiatPerBtc: 8_000_000 });
    expect(minted[0]).toMatchObject({ amountMsat: 15_000_000, description: 'Sattle: Yash, Flat 4B' });

    const row = db.prepare('SELECT payment_hash FROM settlements WHERE id = ?').get(s.id);
    expect(row).toEqual({ payment_hash: HASH });
  });

  it('lets the invoice expire no later than the quote', async () => {
    const s = await settled((await omPaysYash()).body.id);
    const quoteLeft = (Date.parse(s.quote!.expiresAt) - NOW) / 1000;
    expect(minted[0].expirySec).toBeGreaterThan(0);
    expect(minted[0].expirySec).toBeLessThanOrEqual(quoteLeft);
  });

  it('reuses one connection per wallet', async () => {
    const before = opened;
    await settled((await omPaysYash('invoice', 10_000)).body.id);
    db.prepare(`UPDATE settlements SET status = 'expired'`).run();
    await settled((await omPaysYash('invoice', 10_000)).body.id);
    expect(opened - before).toBe(1);
  });

  it('fails honestly when the wallet does not answer', async () => {
    mintError = new NwcError('TIMEOUT', 'slow');
    const s = await settled((await omPaysYash()).body.id);
    expect(s).toMatchObject({ status: 'failed', failureReason: 'Yash’s wallet didn’t answer. Nothing moved.' });
  });

  it('does not take Lightning-address payments it could never confirm', async () => {
    const s = await settled((await omPaysYash('lightning_address')).body.id);
    expect(s.status).toBe('failed');
    expect(minted).toHaveLength(0);
  });
});

describe('NwcPayments without a connected wallet', () => {
  it('fails, naming who has to connect one', async () => {
    const s = await settled((await omPaysYash()).body.id);
    expect(s).toMatchObject({ status: 'failed', failureReason: 'Yash hasn’t connected a wallet to receive yet. Nothing moved.' });
  });
});
