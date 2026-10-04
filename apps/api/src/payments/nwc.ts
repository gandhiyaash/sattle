/**
 * Real payments. For each settlement: pin a quote at the live rate, mint an
 * invoice on the payee's own wallet over their NWC connection, and store its
 * payment hash. The server never holds funds; the invoice pays the payee
 * directly.
 *
 * The invoice expires no later than the quote. Otherwise a guest could pay
 * an old invoice at a stale rate after a fresh one has been minted.
 *
 * Confirmation: every open invoice is looked up on the payee's wallet each
 * `pollMs`. Only the wallet decides the outcome. If it can't be reached we
 * keep asking rather than calling the invoice expired, because it may have
 * been paid before it lapsed. A restart picks the open invoices up again
 * (resume), since they live in the database, not in memory.
 *
 * Rails:
 *   invoice, in_app     an invoice on the payee's wallet
 *   lightning_address   not handled: the payee's NWC can't see payments to
 *                       an address, so we'd have no way to confirm it
 */

import { buildQuote, type Settlement } from '@sattle/core';

import { transaction, type Db } from '../db';
import { NwcError, preimageMatches, type NwcApi } from '../nwc';
import type { PaymentBackend } from '../payments';
import type { RateService } from '../rates';
import type { Repo } from '../repo';
import type { WalletStore } from '../walletStore';

export interface NwcPaymentsDeps {
  db: Db;
  repo: Repo;
  wallets: WalletStore;
  rates: RateService;
  nwc: (uri: string) => NwcApi;
  now?: () => number;
  /** How often open invoices are looked up. */
  pollMs?: number;
}

interface Watched {
  settlementId: string;
  uri: string;
  paymentHash: string;
}

const OPEN = `('awaiting_payment', 'in_flight')`;

/**
 * How long past its expiry an invoice is still watched before `expired` is
 * believed. A payment that lands in the last second can take a moment to
 * show up in the wallet's records; closing it early would leave a paid debt
 * open and ask the payer to pay again.
 */
export const EXPIRY_GRACE_MS = 30_000;

export class NwcPayments implements PaymentBackend {
  /** One client per connection string, kept open: each new one costs a relay handshake. */
  private readonly clients = new Map<string, NwcApi>();
  private readonly setHash;
  private readonly hashTaken;
  private readonly groupName;
  private readonly openInvoices;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly watched = new Map<string, Watched>();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly deps: NwcPaymentsDeps) {
    this.setHash = deps.db.prepare('UPDATE settlements SET payment_hash = ? WHERE id = ?');
    this.hashTaken = deps.db.prepare('SELECT 1 FROM settlements WHERE payment_hash = ?');
    this.groupName = deps.db.prepare('SELECT name FROM expense_groups WHERE id = ?');
    this.openInvoices = deps.db.prepare(
      `SELECT id, to_member_id, payment_hash FROM settlements WHERE status IN ${OPEN}`
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
    const rows = this.openInvoices.all() as { id: string; to_member_id: string; payment_hash: string | null }[];
    let watching = 0;
    for (const r of rows) {
      if (!r.payment_hash) {
        this.finish(r.id, { status: 'expired', failureReason: 'This invoice wasn’t a real one. Nothing moved.' });
        continue;
      }
      const uri = this.uriFor(r.to_member_id);
      if (!uri) {
        console.warn(`settlement ${r.id}: payee's wallet is no longer connected; can't confirm it`);
        continue;
      }
      this.watch({ settlementId: r.id, uri, paymentHash: r.payment_hash });
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
    if (!uri) {
      return this.fail(s.id, `${payee.displayName} hasn’t connected a wallet to receive yet. Nothing moved.`);
    }

    const rate = await rates.rate(s.currency);
    const quote = buildQuote(s.amount, s.currency, rate.rateFiatPerBtc, this.now());
    // Rounded down, so the invoice dies with the quote or just before it.
    const expirySec = Math.floor((Date.parse(quote.expiresAt) - this.now()) / 1000);

    let invoice;
    try {
      invoice = await this.client(uri).makeInvoice({
        amountMsat: quote.amountSat * 1000,
        description: `Sattle: ${payee.displayName}, ${(this.groupName.get(s.groupId) as { name?: string } | undefined)?.name ?? 'settle up'}`,
        expirySec,
      });
    } catch (e) {
      return this.fail(s.id, mintFailure(e, payee.displayName));
    }

    // One payment hash, one settlement: otherwise a single payment would
    // confirm both. The unique index (migration 011) backs this up.
    const fresh = transaction(this.deps.db, () => {
      if (this.hashTaken.get(invoice.paymentHash)) return false;
      this.setHash.run(invoice.paymentHash, s.id);
      repo.updateSettlement(s.id, { status: 'awaiting_payment', quote, destination: invoice.invoice });
      return true;
    });
    if (!fresh) {
      console.warn(`settlement ${s.id}: wallet returned an invoice we already hold`);
      return this.fail(s.id, `${payee.displayName}’s wallet gave us an invoice it had already given us. Nothing moved.`);
    }
    this.watch({ settlementId: s.id, uri, paymentHash: invoice.paymentHash });
  }

  // -------------------------------------------------------------------------
  // Confirmation
  // -------------------------------------------------------------------------

  private watch(w: Watched) {
    this.watched.set(w.settlementId, w);
    this.schedule();
  }

  private schedule() {
    if (this.timer || this.watched.size === 0) return;
    this.timer = setTimeout(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
  }

  /** One lookup per open invoice, all at once. The next tick waits for this one. */
  private async tick() {
    await Promise.all([...this.watched.values()].map((w) => this.check(w)));
    this.timer = undefined;
    this.schedule();
  }

  private async check(w: Watched) {
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

function mintFailure(e: unknown, payeeName: string) {
  if (e instanceof NwcError) {
    if (e.code === 'TIMEOUT' || e.code === 'RELAY') return `${payeeName}’s wallet didn’t answer. Nothing moved.`;
    if (e.code === 'INVALID_AMOUNT') return 'That’s less than 1 sat, too small to send over Lightning.';
    return `${payeeName}’s wallet couldn’t make an invoice (${e.code}). Nothing moved.`;
  }
  console.error('make_invoice failed unexpectedly', e instanceof Error ? e.message : e);
  return 'Something went wrong on our side. Nothing moved.';
}
