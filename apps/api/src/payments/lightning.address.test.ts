/**
 * LightningPayments receiving at a Lightning address: a joined member with
 * no NWC wallet who has set their own address. The LNURL client is faked;
 * its own checks are in lnurl.test.ts.
 */

import { createHash, randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { QUOTE_TTL_MS, type Settlement } from '@sattle/core';

import { createApp } from '../app';
import { openDb, seedIfEmpty, type Db } from '../db';
import { LnurlError, type AddressInvoice, type VerifyResult } from '../lnurl';
import type { NwcApi } from '../nwc';
import type { RateService } from '../rates';
import { createRepo } from '../repo';
import { newSettlement } from '../settlementRules';
import { createWalletStore } from '../walletStore';
import {
  ADDRESS_MINTS_PER_MINUTE,
  EXPIRY_GRACE_MS,
  LightningPayments,
  MAX_WATCH_MS,
  UNREACHABLE_GIVE_UP_MS,
  VERIFY_PER_HOST,
} from './lightning';

const ADDRESS = 'yash@wallet.example';
const VERIFY_HOST = 'wallet.example';
const NWC_URI = `nostr+walletconnect://${'a'.repeat(64)}?relay=wss://relay.example&secret=${'b'.repeat(64)}`;
const rates: RateService = { rate: async (currency) => ({ currency, rateFiatPerBtc: 8_000_000, source: 'live' }) };

let db: Db;
let now: number;
let backend: LightningPayments | undefined;
let preimages: string[];
let requested: { address: string; amountMsat: number }[];
let verified: string[];
/** What the address does when asked for an invoice. */
let mint: (n: number) => Partial<AddressInvoice> | Error;
/** What the verify link answers for invoice n. */
let verify: (n: number) => VerifyResult | Error;
let nwcMinted: number;

const hashOf = (preimage: string) => createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');

const fakeLnurl = {
  requestInvoice: async (address: string, amountMsat: number): Promise<AddressInvoice> => {
    requested.push({ address, amountMsat });
    const n = requested.length - 1;
    const answer = mint(n);
    if (answer instanceof Error) throw answer;
    preimages[n] = randomBytes(32).toString('hex');
    return {
      invoice: `lnbc${n}address`,
      paymentHash: hashOf(preimages[n]),
      amountMsat,
      expiresAt: Math.floor(now / 1000) + 600,
      verifyUrl: `https://${VERIFY_HOST}/verify/${n}`,
      ...answer,
    };
  },
  verify: async (url: string, paymentHash: string): Promise<VerifyResult> => {
    verified.push(url);
    const n = Number(url.split('/').pop());
    expect(paymentHash).toBe(hashOf(preimages[n]));
    const answer = verify(n);
    if (answer instanceof Error) throw answer;
    return answer;
  },
};

const fakeNwc = (): NwcApi => ({
  getInfo: async () => ({ methods: ['get_info', 'make_invoice', 'lookup_invoice'] }),
  makeInvoice: async (p) => {
    nwcMinted++;
    return { invoice: 'lnbc1nwc', paymentHash: randomBytes(32).toString('hex'), amountMsat: p.amountMsat, createdAt: 0, state: 'pending' };
  },
  lookupInvoice: async (p) => ({ invoice: 'lnbc1nwc', paymentHash: 'paymentHash' in p ? p.paymentHash : '', amountMsat: 1, createdAt: 0, state: 'pending' }),
  close: () => {},
});

function newBackend(withLnurl = true) {
  const repo = createRepo(db);
  return new LightningPayments({
    db,
    repo,
    wallets: createWalletStore(db),
    rates,
    nwc: fakeNwc,
    lnurl: withLnurl ? fakeLnurl : undefined,
    now: () => now,
    pollMs: 2,
  });
}

function as(userId: string) {
  return createApp({ db, demoUserId: userId, nwc: fakeNwc, payments: () => (backend ??= newBackend()) });
}

async function call<T = unknown>(userId: string, method: string, path: string, body?: unknown) {
  const res = await as(userId).request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.clone().text(), body: (await res.json()) as T };
}

const get = async (id: string) => (await call<Settlement>('u-om', 'GET', `/settlements/${id}`)).body;
const wait = () => new Promise((r) => setTimeout(r, 4));

async function until(id: string, done: (s: Settlement) => boolean) {
  for (let i = 0; i < 300; i++) {
    const s = await get(id);
    if (done(s)) return s;
    await wait();
  }
  throw new Error(`settlement ${id} never got there: ${JSON.stringify(await get(id))}`);
}
const minted = (id: string) => until(id, (s) => s.status !== 'created');
const closed = (id: string) => until(id, (s) => s.status !== 'created' && s.status !== 'awaiting_payment');

/** Lets the loop run a few times at the current clock. */
async function settle(runs = 5) {
  for (let i = 0; i < runs; i++) await wait();
}

/** Om pays Yash ₹1,200 in Flat 4B. */
const omPaysYash = async () => {
  const res = await call<Settlement>('u-om', 'POST', '/groups/g-flat/settlements', {
    fromMemberId: 'm-flat-om',
    toMemberId: 'm-flat-yash',
    amount: 120_000,
    rail: 'invoice',
  });
  expect(res.status).toBe(201);
  return res.body.id;
};

const row = (id: string) =>
  db.prepare('SELECT payment_hash, receive_via, verify_url, invoice_expires_at FROM settlements WHERE id = ?').get(id) as {
    payment_hash: string;
    receive_via: string;
    verify_url: string | null;
    invoice_expires_at: number;
  };

beforeEach(async () => {
  db = openDb(':memory:');
  seedIfEmpty(db);
  db.prepare(`UPDATE settlements SET status = 'expired' WHERE id = 'demo'`).run();
  now = Date.now();
  backend = undefined;
  preimages = [];
  requested = [];
  verified = [];
  nwcMinted = 0;
  mint = () => ({});
  verify = () => ({ settled: false });
  // Yash sets his own address; he has no NWC wallet.
  expect((await call('u-yash', 'PUT', '/members/m-flat-yash/payout-address', { address: ADDRESS })).status).toBe(200);
});

afterEach(() => backend?.close());

describe('minting from an address', () => {
  it('asks the payee’s own address for the quoted amount and shows that invoice', async () => {
    const id = await omPaysYash();
    const s = await minted(id);
    expect(s).toMatchObject({ status: 'awaiting_payment', destination: 'lnbc0address' });
    // ₹1,200 at ₹80,00,000/BTC = 15,000 sats.
    expect(s.quote).toMatchObject({ amountSat: 15_000 });
    expect(requested).toEqual([{ address: ADDRESS, amountMsat: 15_000_000 }]);
    expect(row(id)).toMatchObject({ payment_hash: hashOf(preimages[0]), receive_via: 'address', verify_url: `https://${VERIFY_HOST}/verify/0` });
  });

  it('never sends the verify link out', async () => {
    const id = await omPaysYash();
    await minted(id);
    for (const path of [`/settlements/${id}`, '/groups/g-flat/settlements']) {
      expect((await call('u-om', 'GET', path)).text).not.toContain('/verify/');
    }
  });

  it('prefers the payee’s NWC wallet when they have both', async () => {
    expect((await call('u-yash', 'PUT', '/me/wallet', { nwcUri: NWC_URI })).status).toBe(200);
    const s = await minted(await omPaysYash());
    expect(s.destination).toBe('lnbc1nwc');
    expect(nwcMinted).toBe(1);
    expect(requested).toEqual([]);
  });

  it('uses the address the payee set for every group, ahead of one set in this group', async () => {
    db.prepare(`UPDATE users SET receive_address = 'yash@everywhere.example' WHERE id = 'u-yash'`).run();
    await minted(await omPaysYash());
    expect(requested[0].address).toBe('yash@everywhere.example');
  });

  it('uses the payee’s receive address when they set none in this group', async () => {
    db.prepare(`UPDATE members SET lightning_address = NULL WHERE id = 'm-flat-yash'`).run();
    db.prepare(`UPDATE users SET receive_address = 'yash@everywhere.example' WHERE id = 'u-yash'`).run();
    expect((await minted(await omPaysYash())).status).toBe('awaiting_payment');
    expect(requested[0].address).toBe('yash@everywhere.example');
  });

  it('has nowhere to mint when the server has no LNURL client', async () => {
    backend = newBackend(false);
    const s = await minted(await omPaysYash());
    expect(s).toMatchObject({ status: 'failed', failureReason: 'Yash hasn’t connected a wallet to receive yet. Nothing moved.' });
  });

  it.each([
    [new LnurlError('UNREACHABLE', 'x'), 'Yash’s Lightning address didn’t answer. Nothing moved.'],
    [new LnurlError('PROVIDER_ERROR', 'User not found'), 'Yash’s Lightning address said no: User not found. Nothing moved.'],
    [
      new LnurlError('AMOUNT_OUT_OF_RANGE', 'x', { minMsat: 1_000, maxMsat: 10_000_000 }),
      'Yash’s Lightning address only takes 1 to 10,000 sats at a time. Nothing moved.',
    ],
    [new LnurlError('BAD_INVOICE', 'x'), 'Yash’s Lightning address sent an invoice we couldn’t check, so we didn’t show it. Nothing moved.'],
  ])('fails plainly when the address can’t give an invoice (%s)', async (error, reason) => {
    mint = () => error;
    expect(await minted(await omPaysYash())).toMatchObject({ status: 'failed', failureReason: reason });
  });

  it('caps how often one address is asked, since anyone with a pay link can open it', async () => {
    mint = () => new LnurlError('UNREACHABLE', 'x'); // each fails at once, freeing the pair
    for (let i = 0; i < ADDRESS_MINTS_PER_MINUTE; i++) await minted(await omPaysYash());
    const capped = await minted(await omPaysYash());
    expect(capped.failureReason).toBe('Too many invoices for Yash just now. Try again in a minute. Nothing moved.');
    expect(requested).toHaveLength(ADDRESS_MINTS_PER_MINUTE);

    now += 61_000;
    await minted(await omPaysYash());
    expect(requested).toHaveLength(ADDRESS_MINTS_PER_MINUTE + 1);
  });
});

describe('confirming with the verify link', () => {
  it('confirms with the preimage once the link shows it paid', async () => {
    const id = await omPaysYash();
    await minted(id);
    verify = (n) => ({ settled: true, preimage: preimages[n] });
    now += 3_000;
    const s = await closed(id);
    expect(s).toMatchObject({ status: 'confirmed', preimage: preimages[0] });
  });

  it('asks briskly at first, then less often', async () => {
    mint = () => ({ expiresAt: Math.floor(now / 1000) + 3600 });
    const id = await omPaysYash();
    await minted(id);
    await settle();
    expect(verified).toHaveLength(0); // not due yet

    now += 3_000;
    await until(id, () => verified.length === 1);
    await settle();
    expect(verified).toHaveLength(1);

    now += 20 * 60_000; // an old invoice: every 30s
    await until(id, () => verified.length === 2);
    now += 10_000;
    await settle();
    expect(verified).toHaveLength(2);
    now += 20_000;
    await until(id, () => verified.length === 3);
  });

  it('keeps watching after the quote lapses, while the payer is free to get a new invoice', async () => {
    const first = await omPaysYash();
    await minted(first);
    now += QUOTE_TTL_MS + 1_000;
    // Wall-clock: isInProgress reads Date.now, so lapse the stored quote.
    db.prepare(`UPDATE settlements SET quote = json_set(quote, '$.expiresAt', ?) WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), first);

    const second = await omPaysYash();
    await minted(second);
    expect((await get(first)).status).toBe('awaiting_payment');

    // The first invoice is paid late: it still counts.
    verify = (n) => (n === 0 ? { settled: true, preimage: preimages[0] } : { settled: false });
    now += 10_000;
    expect((await closed(first)).status).toBe('confirmed');
    expect((await get(second)).status).toBe('awaiting_payment');
  });

  it('calls it expired when the link still says unpaid after the invoice ends', async () => {
    const id = await omPaysYash();
    await minted(id);
    now += 600_000 + EXPIRY_GRACE_MS;
    expect((await closed(id)).status).toBe('expired');
  });

  it('keeps asking while the provider is unreachable, and gives up long after the invoice ends', async () => {
    const id = await omPaysYash();
    await minted(id);
    verify = () => new LnurlError('UNREACHABLE', 'x');
    now += 600_000 + EXPIRY_GRACE_MS;
    await until(id, () => verified.length >= 1);
    await settle();
    expect((await get(id)).status).toBe('awaiting_payment');

    now += UNREACHABLE_GIVE_UP_MS;
    expect(await closed(id)).toMatchObject({
      status: 'expired',
      failureReason: 'We couldn’t reach Yash’s wallet to check this. If you paid it, send your payment proof or ask Yash to mark it settled.',
    });
  });

  it('watches a day at most, however long the invoice says it lives', async () => {
    mint = () => ({ expiresAt: Math.floor(now / 1000) + 7 * 24 * 3600 });
    const id = await omPaysYash();
    await minted(id);
    now += MAX_WATCH_MS + EXPIRY_GRACE_MS;
    expect((await closed(id)).status).toBe('expired');
  });

  it('asks one host only a few times per run, so a busy provider isn’t flooded', async () => {
    backend = newBackend();
    const repo = createRepo(db);
    const g = repo.group('g-flat')!;
    const ids: string[] = [];
    for (let i = 0; i < VERIFY_PER_HOST + 2; i++) {
      const s = repo.insertSettlement(newSettlement(g, { fromMemberId: 'm-flat-om', toMemberId: 'm-flat-yash', amount: 100 }, 'invoice', 'created'));
      ids.push(s.id);
      backend.start(s);
    }
    for (const id of ids) await minted(id);

    now += 3_000;
    await until(ids[0], () => verified.length >= VERIFY_PER_HOST);
    // The first run asked VERIFY_PER_HOST; the rest come in the next runs.
    await until(ids[0], () => verified.length === ids.length);
    expect(new Set(verified).size).toBe(ids.length);
  });
});

describe('an address with no verify link', () => {
  beforeEach(() => {
    mint = () => ({ verifyUrl: undefined });
  });

  it('waits for the invoice to end, then says it couldn’t tell', async () => {
    const id = await omPaysYash();
    expect((await minted(id)).status).toBe('awaiting_payment');
    expect(row(id).verify_url).toBeNull();
    now += 600_000;
    await settle();
    expect((await get(id)).status).toBe('awaiting_payment');

    now += EXPIRY_GRACE_MS;
    expect(await closed(id)).toMatchObject({
      status: 'expired',
      failureReason: 'Yash’s wallet can’t tell us whether this was paid. If you paid it, send your payment proof or ask Yash to mark it settled.',
    });
    expect(verified).toEqual([]);
  });
});

describe('after a restart', () => {
  it('picks address invoices up again and confirms them', async () => {
    const id = await omPaysYash();
    await minted(id);
    backend!.close();

    backend = newBackend();
    expect(backend.resume()).toBe(1);
    verify = (n) => ({ settled: true, preimage: preimages[n] });
    now += 3_000;
    expect((await closed(id)).status).toBe('confirmed');
  });
});

describe('proof of payment', () => {
  const prove = (id: string, preimage: string, as = 'u-om') => call<Settlement & { code?: string; message?: string }>(as, 'POST', `/settlements/${id}/proof`, { preimage });
  const guestProve = (preimage: string, token = 'demo') =>
    call<{ settlement?: Settlement; code?: string; message?: string }>('u-om', 'POST', `/s/${token}/proof`, { preimage });

  beforeEach(() => {
    mint = () => ({ verifyUrl: undefined }); // a provider that can't tell us
  });

  it('confirms an invoice with its preimage, however it was pasted', async () => {
    const id = await omPaysYash();
    await minted(id);
    const res = await prove(id, `  ${preimages[0].toUpperCase()}\n`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'confirmed', preimage: preimages[0] });
    expect(res.body.failureReason).toBeUndefined();
  });

  it('confirms one we’d already called expired, and clears the reason', async () => {
    const id = await omPaysYash();
    await minted(id);
    now += 600_000 + EXPIRY_GRACE_MS;
    expect((await closed(id)).status).toBe('expired');

    const res = await prove(id, preimages[0]);
    expect(res.body).toMatchObject({ status: 'confirmed', preimage: preimages[0] });
    expect(res.body.failureReason).toBeUndefined();
  });

  it('is fine to send twice', async () => {
    const id = await omPaysYash();
    await minted(id);
    const first = await prove(id, preimages[0]);
    const again = await prove(id, preimages[0]);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
  });

  it('stops the watch: a later verify answer can’t move it', async () => {
    mint = () => ({}); // with a verify link this time
    verify = () => ({ settled: false });
    const id = await omPaysYash();
    await minted(id);
    await prove(id, preimages[0]);
    now += 600_000 + EXPIRY_GRACE_MS;
    await settle(10);
    expect((await get(id)).status).toBe('confirmed');
  });

  it('refuses a proof for another payment, or something that isn’t one', async () => {
    const id = await omPaysYash();
    await minted(id);
    const wrong = await prove(id, randomBytes(32).toString('hex'));
    expect(wrong).toMatchObject({ status: 400, body: { code: 'invalid_input', message: 'That proof is for a different payment.' } });
    for (const junk of ['abc', 'g'.repeat(64), preimages[0].slice(1), `${preimages[0]}00`]) {
      expect((await prove(id, junk)).status).toBe(400);
    }
    expect((await get(id)).status).toBe('awaiting_payment');
  });

  it('refuses a payment that never had an invoice', async () => {
    const manual = await call<Settlement>('u-yash', 'POST', '/groups/g-flat/settlements/manual', {
      fromMemberId: 'm-flat-om',
      toMemberId: 'm-flat-yash',
      amount: 1_000,
    });
    expect(manual.status).toBe(201);
    expect((await prove(manual.body.id, randomBytes(32).toString('hex'), 'u-yash')).status).toBe(400);
  });

  it('is 404 to someone outside the group', async () => {
    const id = await omPaysYash();
    await minted(id);
    expect((await prove(id, preimages[0], 'u-priya')).status).toBe(404);
    expect((await get(id)).status).toBe('awaiting_payment');
  });

  describe('on a pay link', () => {
    const openLink = async () => {
      expect((await call('u-om', 'POST', '/s/demo/open')).status).toBe(200);
      const id = (db.prepare(`SELECT id FROM settlements WHERE pay_link_token = 'demo' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as { id: string }).id;
      await minted(id);
      return id;
    };

    it('lets the guest confirm with their proof, and shows them it’s paid', async () => {
      const id = await openLink();
      const res = await guestProve(preimages[0]);
      expect(res.status).toBe(200);
      expect(res.body.settlement).toMatchObject({ id, status: 'confirmed', preimage: preimages[0] });
    });

    it('takes a proof for an older invoice the link opened', async () => {
      const first = await openLink();
      db.prepare(`UPDATE settlements SET status = 'expired' WHERE id = ?`).run(first);
      const second = await openLink();
      expect(second).not.toBe(first);

      const res = await guestProve(preimages[0]);
      expect(res.body.settlement).toMatchObject({ id: first, status: 'confirmed' });
      expect((await get(second)).status).toBe('awaiting_payment');
    });

    it('refuses a proof for a payment the link didn’t open, without saying whether it exists', async () => {
      const id = await omPaysYash(); // same pair, but not through the link
      await minted(id);
      const res = await guestProve(preimages[0]);
      expect(res).toMatchObject({ status: 400, body: { message: 'That proof is for a different payment.' } });
      expect((await get(id)).status).toBe('awaiting_payment');
      expect((await guestProve(randomBytes(32).toString('hex'))).body.message).toBe('That proof is for a different payment.');
    });
  });
});
