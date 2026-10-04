import { createHash, randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Settlement } from '@sattle/core';

import { createApp } from '../app';
import { openDb, seedIfEmpty, type Db } from '../db';
import { NwcError, type MakeInvoiceParams, type NwcApi, type NwcInvoice } from '../nwc';
import type { RateService } from '../rates';
import { NwcPayments } from './nwc';

const URI = `nostr+walletconnect://${'a'.repeat(64)}?relay=wss://relay.example&secret=${'b'.repeat(64)}`;
const PREIMAGE = randomBytes(32).toString('hex');
const HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex');
const NOW = Date.parse('2026-10-02T10:00:00Z');

let db: Db;
let minted: MakeInvoiceParams[];
let mintError: Error | undefined;
let opened: number;
let backend: NwcPayments | undefined;
/** What lookup_invoice answers. Swap it mid-test to move the invoice along. */
let lookup: () => Partial<NwcInvoice> | Error;
let lookups: number;

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
    lookupInvoice: async ({ paymentHash }: { paymentHash: string }) => {
      lookups++;
      const answer = lookup();
      if (answer instanceof Error) throw answer;
      return { invoice: 'lnbc1real', paymentHash, amountMsat: 1, createdAt: NOW / 1000, state: 'pending', ...answer };
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
    payments: (repo, wallets) =>
      (backend ??= new NwcPayments({ db, repo, wallets, rates, nwc: fakeNwc, now: () => NOW, pollMs: 2 })),
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

const get = async (id: string) => (await call<Settlement>('u-om', 'GET', `/settlements/${id}`)).body;

async function until(id: string, done: (s: Settlement) => boolean) {
  for (let i = 0; i < 200; i++) {
    const s = await get(id);
    if (done(s)) return s;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`settlement ${id} never got there`);
}

/** Past `created`: an invoice was minted, or it failed trying. */
const settled = (id: string) => until(id, (s) => s.status !== 'created');
const closed = (id: string) => until(id, (s) => s.status !== 'created' && s.status !== 'awaiting_payment');

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
  backend?.close();
  backend = undefined;
  lookup = () => ({ state: 'pending' });
  lookups = 0;
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
    expect(s.quote).toMatchObject({
      amountFiat: 120_000,
      amountSat: 15_000,
      rateFiatPerBtc: 8_000_000,
      rateSource: { kind: 'market', provider: 'CoinGecko' },
    });
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

describe('confirmation loop', () => {
  beforeEach(async () => {
    await call('u-yash', 'PUT', '/me/wallet', { nwcUri: URI });
  });

  it('confirms once the payee’s wallet says it was paid, keeping the preimage as a receipt', async () => {
    const { id } = (await omPaysYash()).body;
    await until(id, () => lookups >= 2);
    expect((await get(id)).status).toBe('awaiting_payment');

    lookup = () => ({ state: 'settled', settledAt: NOW / 1000, preimage: PREIMAGE });
    expect(await closed(id)).toMatchObject({ status: 'confirmed', preimage: PREIMAGE });
  });

  it('confirms without a receipt when the preimage is not this invoice’s', async () => {
    lookup = () => ({ state: 'settled', settledAt: NOW / 1000, preimage: 'e'.repeat(64) });
    const s = await closed((await omPaysYash()).body.id);
    expect(s.status).toBe('confirmed');
    expect(s.preimage).toBeUndefined();
  });

  it('marks it expired when the wallet says so, which frees the debt for a new invoice', async () => {
    lookup = () => ({ state: 'expired' });
    expect((await closed((await omPaysYash()).body.id)).status).toBe('expired');
    expect((await omPaysYash()).status).toBe(201);
  });

  it('waits out the grace period before believing an invoice expired', async () => {
    // Expired 10s ago by its own clock: inside the grace period, so still watched.
    lookup = () => ({ state: 'expired', expiresAt: NOW / 1000 - 10 });
    const { id } = (await omPaysYash()).body;
    await settled(id);
    const before = lookups;
    await until(id, () => lookups >= before + 3);
    expect((await get(id)).status).toBe('awaiting_payment');

    // The payment that landed at the last second shows up: it confirms.
    lookup = () => ({ state: 'settled', settledAt: NOW / 1000 - 11 });
    expect((await closed(id)).status).toBe('confirmed');
  });

  it('closes an invoice once it is past the grace period', async () => {
    lookup = () => ({ state: 'expired', expiresAt: NOW / 1000 - 31 });
    expect((await closed((await omPaysYash()).body.id)).status).toBe('expired');
  });

  it('keeps asking through a wallet that does not answer, rather than guessing', async () => {
    lookup = () => new NwcError('TIMEOUT', 'slow');
    const { id } = (await omPaysYash()).body;
    await until(id, () => lookups >= 3);
    expect((await get(id)).status).toBe('awaiting_payment');

    lookup = () => ({ state: 'settled', settledAt: NOW / 1000 });
    expect((await closed(id)).status).toBe('confirmed');
  });

  it('leaves a settlement alone once it has been closed some other way', async () => {
    const { id } = (await omPaysYash()).body;
    await settled(id);
    db.prepare(`UPDATE settlements SET status = 'failed' WHERE id = ?`).run(id);
    lookup = () => ({ state: 'settled', settledAt: NOW / 1000 });
    const before = lookups;
    await until(id, () => lookups > before);
    expect((await get(id)).status).toBe('failed');
  });

  it('picks up open invoices again after a restart', async () => {
    const { id } = (await omPaysYash()).body;
    await settled(id);
    backend!.close(); // the process dies
    backend = undefined;
    // Put the seeded demo invoice back: it has no payment hash, so it was never real.
    db.prepare(`UPDATE settlements SET status = 'awaiting_payment' WHERE id = 'demo'`).run();

    lookup = () => ({ state: 'settled', settledAt: NOW / 1000, preimage: PREIMAGE });
    as('u-om'); // boot builds the backend
    expect(backend!.resume()).toBe(1);

    expect(await closed(id)).toMatchObject({ status: 'confirmed', preimage: PREIMAGE });
    expect((await get('demo')).status).toBe('expired');
  });
});
