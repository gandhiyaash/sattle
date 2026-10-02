/**
 * Real payments. For each settlement: pin a quote at the live rate, mint an
 * invoice on the payee's own wallet over their NWC connection, and store its
 * payment hash. The server never holds funds; the invoice pays the payee
 * directly.
 *
 * The invoice expires no later than the quote. Otherwise a guest could pay
 * an old invoice at a stale rate after a fresh one has been minted.
 *
 * Rails:
 *   invoice, in_app     an invoice on the payee's wallet
 *   lightning_address   not handled: the payee's NWC can't see payments to
 *                       an address, so we'd have no way to confirm it
 */

import { buildQuote, type Settlement } from '@sattle/core';

import { transaction, type Db } from '../db';
import { NwcError, type NwcApi } from '../nwc';
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
}

export class NwcPayments implements PaymentBackend {
  /** One client per connection string, kept open: each new one costs a relay handshake. */
  private readonly clients = new Map<string, NwcApi>();
  private readonly setHash;
  private readonly groupName;
  private readonly now: () => number;

  constructor(private readonly deps: NwcPaymentsDeps) {
    this.setHash = deps.db.prepare('UPDATE settlements SET payment_hash = ? WHERE id = ?');
    this.groupName = deps.db.prepare('SELECT name FROM expense_groups WHERE id = ?');
    this.now = deps.now ?? Date.now;
  }

  start(settlement: Settlement) {
    void this.mint(settlement).catch((e) => {
      console.error(`settlement ${settlement.id}: minting crashed`, e instanceof Error ? e.message : e);
      this.fail(settlement.id, 'Something went wrong on our side. Nothing moved.');
    });
  }

  close() {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }

  private async mint(s: Settlement) {
    const { repo, wallets, rates } = this.deps;

    if (s.rail !== 'invoice' && s.rail !== 'in_app') {
      return this.fail(s.id, 'Paying a Lightning address isn’t connected to real payments yet. Nothing moved.');
    }

    const payee = repo.member(s.toMemberId)!;
    const uri = payee.claimedByUserId ? wallets.nwcUriFor(payee.claimedByUserId) : undefined;
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

    transaction(this.deps.db, () => {
      this.setHash.run(invoice.paymentHash, s.id);
      repo.updateSettlement(s.id, { status: 'awaiting_payment', quote, destination: invoice.invoice });
    });
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
