/**
 * Real payments. For each settlement: pin a quote at the live rate, get an
 * invoice that pays the payee directly, and store its payment hash. The
 * server never holds funds.
 *
 * Where the invoice comes from, in order of preference:
 *   1. The payee's NWC connection: minted on their own wallet.
 *   2. The payee's Lightning address (LNURL-pay), for wallets that can't do
 *      NWC. Only a joined member's own address is used: joining clears one a
 *      groupmate typed (migration 010), so a payment to it is a payment to
 *      them.
 *
 * How we learn it was paid:
 *   nwc     lookup_invoice on the payee's wallet. The NWC invoice expires no
 *           later than the quote, so an old invoice can't be paid at a stale
 *           rate after a fresh one has been minted.
 *   verify  the address's LUD-21 verify link, which counts only with a
 *           preimage for the invoice's hash. We can't set an address
 *           invoice's expiry, so it can outlive its quote. The settlement
 *           stops counting as in progress when the quote lapses (see
 *           isInProgress), so the payer can get a fresh one, and the old
 *           invoice is still watched: a late payment is still a payment. The
 *           watch slows as the invoice ages.
 *   proof   the address has no verify link: only a preimage from the payer
 *           confirms it (L5). When the invoice expires we close it, saying
 *           we couldn't tell.
 *
 * If the wallet or provider can't be reached we keep asking rather than
 * calling the invoice expired, because it may have been paid. A restart picks
 * open invoices up again (resume), since they live in the database.
 *
 * Rails:
 *   invoice, in_app     an invoice from the payee's wallet or address
 *   lightning_address   not handled: that's a ghost's address, typed by a
 *                       groupmate, so a payment to it proves nothing
 */

import { buildQuote, type Settlement } from '@sattle/core';

import { transaction, type Db } from '../db';
import { LnurlError, type AddressInvoice, type LnurlClient } from '../lnurl';
import { NwcError, preimageMatches, type NwcApi } from '../nwc';
import type { PaymentBackend } from '../payments';
import type { RateService } from '../rates';
import type { Repo } from '../repo';
import type { WalletStore } from '../walletStore';

export interface LightningPaymentsDeps {
  db: Db;
  repo: Repo;
  wallets: WalletStore;
  rates: RateService;
  nwc: (uri: string) => NwcApi;
  /** Without it, only NWC wallets can receive. */
  lnurl?: Pick<LnurlClient, 'requestInvoice' | 'verify'>;
  now?: () => number;
  /** How often the loop runs. NWC invoices are looked up every run; verify links as they come due. */
  pollMs?: number;
}

type Watched =
  | { via: 'nwc'; settlementId: string; paymentHash: string; uri: string }
  | {
      via: 'verify';
      settlementId: string;
      paymentHash: string;
      verifyUrl: string;
      host: string;
      payeeName: string;
      /** When we stop watching: the invoice's expiry, at most MAX_WATCH_MS after minting. */
      untilMs: number;
      mintedAtMs: number;
      nextAtMs: number;
    }
  | { via: 'proof'; settlementId: string; payeeName: string; untilMs: number };

const OPEN = `('awaiting_payment', 'in_flight')`;

/**
 * How long past its expiry an invoice is still watched before `expired` is
 * believed. A payment that lands in the last second can take a moment to
 * show up in the wallet's records; closing it early would leave a paid debt
 * open and ask the payer to pay again.
 */
export const EXPIRY_GRACE_MS = 30_000;

/** An address invoice is watched for at most this long, however long it says it lives. */
export const MAX_WATCH_MS = 24 * 60 * 60_000;

/** When a provider can't be reached past the invoice's end, how long we keep trying before giving up. */
export const UNREACHABLE_GIVE_UP_MS = 60 * 60_000;

/** At most this many verify requests to one host in one run of the loop; the rest wait their turn. */
export const VERIFY_PER_HOST = 4;

/** Mints per address per minute. Opening a pay link mints, and anyone with the link can open it. */
export const ADDRESS_MINTS_PER_MINUTE = 6;

/** How long to wait before asking a verify link again: brisk while someone is likely paying, then slower. */
export function verifyDelayMs(ageMs: number) {
  if (ageMs < 2 * 60_000) return 3_000;
  if (ageMs < 15 * 60_000) return 10_000;
  return 30_000;
}

export class LightningPayments implements PaymentBackend {
  /** One client per connection string, kept open: each new one costs a relay handshake. */
  private readonly clients = new Map<string, NwcApi>();
  private readonly setHash;
  private readonly setAddressInvoice;
  private readonly hashTaken;
  private readonly groupName;
  private readonly openInvoices;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly watched = new Map<string, Watched>();
  /** Recent mint times per address, for ADDRESS_MINTS_PER_MINUTE. */
  private readonly mints = new Map<string, number[]>();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly deps: LightningPaymentsDeps) {
    this.setHash = deps.db.prepare(`UPDATE settlements SET payment_hash = ?, receive_via = 'nwc' WHERE id = ?`);
    this.setAddressInvoice = deps.db.prepare(
      `UPDATE settlements SET payment_hash = ?, receive_via = 'address', verify_url = ?, invoice_expires_at = ? WHERE id = ?`
    );
    this.hashTaken = deps.db.prepare('SELECT 1 FROM settlements WHERE payment_hash = ?');
    this.groupName = deps.db.prepare('SELECT name FROM expense_groups WHERE id = ?');
    this.openInvoices = deps.db.prepare(
      `SELECT id, to_member_id, payment_hash, receive_via, verify_url, invoice_expires_at, created_at
         FROM settlements WHERE status IN ${OPEN}`
    );
    this.now = deps.now ?? Date.now;
    this.pollMs = deps.pollMs ?? 1_500;
  }

  /**
   * On boot: watch every invoice that was still open when the process died.
   * A row with no payment hash never had a real invoice (seed data, or a
   * simulator run), so there is nothing to watch and it's closed out.
   */
  resume() {
    const rows = this.openInvoices.all() as {
      id: string;
      to_member_id: string;
      payment_hash: string | null;
      receive_via: string | null;
      verify_url: string | null;
      invoice_expires_at: number | null;
      created_at: string;
    }[];
    let watching = 0;
    for (const r of rows) {
      if (!r.payment_hash) {
        this.finish(r.id, { status: 'expired', failureReason: 'This invoice wasn’t a real one. Nothing moved.' });
        continue;
      }
      if (r.receive_via === 'address') {
        const payeeName = this.deps.repo.member(r.to_member_id)?.displayName ?? 'The payee';
        const mintedAtMs = Date.parse(r.created_at);
        this.watchAddress(r.id, payeeName, mintedAtMs, {
          paymentHash: r.payment_hash,
          verifyUrl: r.verify_url ?? undefined,
          expiresAt: r.invoice_expires_at ?? Math.floor(mintedAtMs / 1000),
        });
        watching++;
        continue;
      }
      // Rows from before migration 012 have no receive_via: they're NWC.
      const uri = this.uriFor(r.to_member_id);
      if (!uri) {
        console.warn(`settlement ${r.id}: payee's wallet is no longer connected; can't confirm it`);
        continue;
      }
      this.watch({ via: 'nwc', settlementId: r.id, uri, paymentHash: r.payment_hash });
      watching++;
    }
    return watching;
  }

  start(settlement: Settlement) {
    void this.mint(settlement).catch((e) => {
      console.error(`settlement ${settlement.id}: minting crashed`, e instanceof Error ? e.message : e);
      this.fail(settlement.id, 'Something went wrong on our side. Nothing moved.');
    });
  }

  close() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.watched.clear();
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }

  private async mint(s: Settlement) {
    const { repo, rates } = this.deps;

    if (s.rail !== 'invoice' && s.rail !== 'in_app') {
      return this.fail(s.id, 'Paying a Lightning address isn’t connected to real payments yet. Nothing moved.');
    }

    const payee = repo.member(s.toMemberId)!;
    const uri = this.uriFor(s.toMemberId);
    const address = this.addressFor(s.toMemberId);
    if (!uri && !address) {
      return this.fail(s.id, `${payee.displayName} hasn’t connected a wallet to receive yet. Nothing moved.`);
    }

    const rate = await rates.rate(s.currency);
    const quote = buildQuote(s.amount, s.currency, rate.rateFiatPerBtc, this.now());

    if (uri) return this.mintNwc(s, payee.displayName, uri, quote);
    return this.mintAddress(s, payee.displayName, address!, quote);
  }

  private async mintNwc(s: Settlement, payeeName: string, uri: string, quote: ReturnType<typeof buildQuote>) {
    // Rounded down, so the invoice dies with the quote or just before it.
    const expirySec = Math.floor((Date.parse(quote.expiresAt) - this.now()) / 1000);

    let invoice;
    try {
      invoice = await this.client(uri).makeInvoice({
        amountMsat: quote.amountSat * 1000,
        description: `Sattle: ${payeeName}, ${(this.groupName.get(s.groupId) as { name?: string } | undefined)?.name ?? 'settle up'}`,
        expirySec,
      });
    } catch (e) {
      return this.fail(s.id, nwcMintFailure(e, payeeName));
    }

    const stored = this.store(s.id, invoice.paymentHash, () => {
      this.setHash.run(invoice.paymentHash, s.id);
      this.deps.repo.updateSettlement(s.id, { status: 'awaiting_payment', quote, destination: invoice.invoice });
    });
    if (!stored) return this.fail(s.id, `${payeeName}’s wallet gave us an invoice it had already given us. Nothing moved.`);
    this.watch({ via: 'nwc', settlementId: s.id, uri, paymentHash: invoice.paymentHash });
  }

  private async mintAddress(s: Settlement, payeeName: string, address: string, quote: ReturnType<typeof buildQuote>) {
    if (!this.allowMint(address)) {
      return this.fail(s.id, `Too many invoices for ${payeeName} just now. Try again in a minute. Nothing moved.`);
    }

    let invoice: AddressInvoice;
    try {
      invoice = await this.deps.lnurl!.requestInvoice(address, quote.amountSat * 1000);
    } catch (e) {
      return this.fail(s.id, addressMintFailure(e, payeeName));
    }

    const stored = this.store(s.id, invoice.paymentHash, () => {
      this.setAddressInvoice.run(invoice.paymentHash, invoice.verifyUrl ?? null, invoice.expiresAt, s.id);
      this.deps.repo.updateSettlement(s.id, { status: 'awaiting_payment', quote, destination: invoice.invoice });
    });
    if (!stored) return this.fail(s.id, `${payeeName}’s Lightning address gave us an invoice it had already given us. Nothing moved.`);
    this.watchAddress(s.id, payeeName, this.now(), invoice);
  }

  /**
   * One payment hash, one settlement: otherwise a single payment would
   * confirm both. The unique index (migration 011) backs this up.
   */
  private store(id: string, paymentHash: string, write: () => void) {
    const fresh = transaction(this.deps.db, () => {
      if (this.hashTaken.get(paymentHash)) return false;
      write();
      return true;
    });
    if (!fresh) console.warn(`settlement ${id}: got an invoice we already hold`);
    return fresh;
  }

  private allowMint(address: string) {
    const cutoff = this.now() - 60_000;
    const recent = (this.mints.get(address) ?? []).filter((t) => t > cutoff);
    if (recent.length >= ADDRESS_MINTS_PER_MINUTE) {
      this.mints.set(address, recent);
      return false;
    }
    recent.push(this.now());
    this.mints.set(address, recent);
    // Drop addresses nobody has minted for in the last minute.
    if (this.mints.size > 1_000) {
      for (const [a, ts] of this.mints) if (ts.every((t) => t <= cutoff)) this.mints.delete(a);
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Confirmation
  // -------------------------------------------------------------------------

  private watchAddress(
    settlementId: string,
    payeeName: string,
    mintedAtMs: number,
    invoice: Pick<AddressInvoice, 'paymentHash' | 'verifyUrl' | 'expiresAt'>
  ) {
    const untilMs = Math.min(invoice.expiresAt * 1000, mintedAtMs + MAX_WATCH_MS);
    if (!invoice.verifyUrl) return this.watch({ via: 'proof', settlementId, payeeName, untilMs });
    this.watch({
      via: 'verify',
      settlementId,
      paymentHash: invoice.paymentHash,
      verifyUrl: invoice.verifyUrl,
      host: new URL(invoice.verifyUrl).host,
      payeeName,
      untilMs,
      mintedAtMs,
      nextAtMs: this.now() + verifyDelayMs(this.now() - mintedAtMs),
    });
  }

  private watch(w: Watched) {
    this.watched.set(w.settlementId, w);
    this.schedule();
  }

  private schedule() {
    if (this.timer || this.watched.size === 0) return;
    this.timer = setTimeout(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
  }

  /** One run of the loop. The next run waits for this one. */
  private async tick() {
    const now = this.now();
    const perHost = new Map<string, number>();
    const due: Promise<void>[] = [];
    for (const w of this.watched.values()) {
      if (w.via === 'nwc') {
        due.push(this.checkNwc(w));
      } else if (w.via === 'proof') {
        this.checkProofOnly(w, now);
      } else if (now >= w.nextAtMs) {
        const n = perHost.get(w.host) ?? 0;
        if (n >= VERIFY_PER_HOST) continue;
        perHost.set(w.host, n + 1);
        due.push(this.checkVerify(w, now));
      }
    }
    await Promise.all(due);
    this.timer = undefined;
    this.schedule();
  }

  private async checkNwc(w: Extract<Watched, { via: 'nwc' }>) {
    let inv;
    try {
      inv = await this.client(w.uri).lookupInvoice({ paymentHash: w.paymentHash });
    } catch (e) {
      // Unreachable or refusing: ask again next tick. Don't guess.
      if (!(e instanceof NwcError)) console.error(`settlement ${w.settlementId}: lookup crashed`, e instanceof Error ? e.message : e);
      return;
    }

    switch (inv.state) {
      case 'pending':
        return;
      case 'settled': {
        // The wallet received it; that's the confirmation. The preimage is
        // only kept as a receipt when it really is this invoice's.
        const proof = inv.preimage && preimageMatches(inv.preimage, w.paymentHash) ? inv.preimage : undefined;
        if (inv.preimage && !proof) console.warn(`settlement ${w.settlementId}: wallet sent a preimage that doesn't match`);
        return this.finish(w.settlementId, { status: 'confirmed', preimage: proof });
      }
      case 'expired':
        if (inv.expiresAt !== undefined && this.now() < inv.expiresAt * 1000 + EXPIRY_GRACE_MS) return;
        return this.finish(w.settlementId, { status: 'expired' });
      case 'failed':
        return this.finish(w.settlementId, { status: 'failed', failureReason: 'The payment didn’t go through. Nothing moved.' });
    }
  }

  private async checkVerify(w: Extract<Watched, { via: 'verify' }>, now: number) {
    w.nextAtMs = now + verifyDelayMs(now - w.mintedAtMs);
    let result;
    try {
      result = await this.deps.lnurl!.verify(w.verifyUrl, w.paymentHash);
    } catch (e) {
      if (!(e instanceof LnurlError)) console.error(`settlement ${w.settlementId}: verify crashed`, e instanceof Error ? e.message : e);
      // Can't ask: that's "don't know". Only give up long after the invoice is over.
      if (this.now() >= w.untilMs + UNREACHABLE_GIVE_UP_MS) {
        this.finish(w.settlementId, {
          status: 'expired',
          failureReason: `We couldn’t reach ${w.payeeName}’s wallet to check this. If you paid it, ask ${w.payeeName} to mark it settled.`,
        });
      }
      return;
    }

    if (result.settled) return this.finish(w.settlementId, { status: 'confirmed', preimage: result.preimage });
    if (this.now() >= w.untilMs + EXPIRY_GRACE_MS) this.finish(w.settlementId, { status: 'expired' });
  }

  private checkProofOnly(w: Extract<Watched, { via: 'proof' }>, now: number) {
    if (now < w.untilMs + EXPIRY_GRACE_MS) return;
    this.finish(w.settlementId, {
      status: 'expired',
      failureReason: `${w.payeeName}’s wallet can’t tell us whether this was paid. If you paid it, ask ${w.payeeName} to mark it settled.`,
    });
  }

  /** Moves an open settlement to its outcome and stops watching it. Never touches a row that's already closed. */
  private finish(id: string, patch: Pick<Settlement, 'status'> & Partial<Pick<Settlement, 'preimage' | 'failureReason'>>) {
    this.watched.delete(id);
    const current = this.deps.repo.settlement(id);
    if (!current || (current.status !== 'awaiting_payment' && current.status !== 'in_flight')) return;
    this.deps.repo.updateSettlement(id, patch);
  }

  private uriFor(memberId: string) {
    const payee = this.deps.repo.member(memberId);
    return payee?.claimedByUserId ? this.deps.wallets.nwcUriFor(payee.claimedByUserId) : undefined;
  }

  /**
   * The payee's own address: the one they set for receiving everywhere, else
   * one they set in this group. A ghost's was typed by someone else, so it
   * doesn't count.
   */
  private addressFor(memberId: string) {
    if (!this.deps.lnurl) return undefined;
    const payee = this.deps.repo.member(memberId);
    if (!payee?.claimedByUserId) return undefined;
    return this.deps.wallets.receiveAddress(payee.claimedByUserId) ?? payee.lightningAddress;
  }

  private client(uri: string) {
    let c = this.clients.get(uri);
    if (!c) {
      c = this.deps.nwc(uri);
      this.clients.set(uri, c);
    }
    return c;
  }

  private fail(id: string, failureReason: string) {
    this.deps.repo.updateSettlement(id, { status: 'failed', failureReason });
  }
}

function nwcMintFailure(e: unknown, payeeName: string) {
  if (e instanceof NwcError) {
    if (e.code === 'TIMEOUT' || e.code === 'RELAY') return `${payeeName}’s wallet didn’t answer. Nothing moved.`;
    if (e.code === 'INVALID_AMOUNT') return 'That’s less than 1 sat, too small to send over Lightning.';
    return `${payeeName}’s wallet couldn’t make an invoice (${e.code}). Nothing moved.`;
  }
  console.error('make_invoice failed unexpectedly', e instanceof Error ? e.message : e);
  return 'Something went wrong on our side. Nothing moved.';
}

function addressMintFailure(e: unknown, payeeName: string) {
  if (e instanceof LnurlError) {
    switch (e.code) {
      case 'UNREACHABLE':
        return `${payeeName}’s Lightning address didn’t answer. Nothing moved.`;
      case 'PROVIDER_ERROR':
        return `${payeeName}’s Lightning address said no: ${/[.!?…]$/.test(e.message) ? e.message : `${e.message}.`} Nothing moved.`;
      case 'AMOUNT_OUT_OF_RANGE': {
        const sats = (msat: number) => Math.ceil(msat / 1000).toLocaleString('en-IN');
        return e.range
          ? `${payeeName}’s Lightning address only takes ${sats(e.range.minMsat)} to ${sats(e.range.maxMsat)} sats at a time. Nothing moved.`
          : `${payeeName}’s Lightning address won’t take that amount. Nothing moved.`;
      }
      case 'INVALID_ADDRESS':
        return `${payeeName}’s Lightning address isn’t valid. Ask them to set it again. Nothing moved.`;
      case 'BAD_INVOICE':
      case 'BAD_RESPONSE':
        return `${payeeName}’s Lightning address sent an invoice we couldn’t check, so we didn’t show it. Nothing moved.`;
    }
  }
  console.error('LNURL invoice request failed unexpectedly', e instanceof Error ? e.message : e);
  return 'Something went wrong on our side. Nothing moved.';
}
