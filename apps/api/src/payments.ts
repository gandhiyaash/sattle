/**
 * Payment seam. Routes create a settlement row in `created` and hand it here;
 * the backend owns every transition after that.
 *
 * SimulatedPayments walks the same path as MockClient so the app behaves
 * identically on either backend. The NWC backend replaces it: quote, mint an
 * invoice on the payee's wallet, watch for the preimage.
 */

import { randomBytes } from 'node:crypto';

import { buildQuote, type Settlement } from '@sattle/core';

import type { Repo } from './repo';

export interface PaymentBackend {
  /** Called once, right after the settlement row is inserted. Must not throw. */
  start(settlement: Settlement): void;
}

export interface SimulatedOptions {
  stepMs: number;
  settleDelayMs: number;
  rateFiatPerBtc: number;
  alwaysFail: boolean;
}

export class SimulatedPayments implements PaymentBackend {
  constructor(
    private readonly repo: Repo,
    private readonly opts: SimulatedOptions
  ) {}

  start(settlement: Settlement) {
    void this.run(settlement).catch((e) => {
      console.error(`settlement ${settlement.id}: simulation crashed`, e);
      this.repo.updateSettlement(settlement.id, { status: 'failed', failureReason: 'Something went wrong on our side.' });
    });
  }

  private async run(s: Settlement) {
    const payee = this.repo.member(s.toMemberId)!;

    await sleep(this.opts.stepMs);
    this.repo.updateSettlement(s.id, {
      status: 'awaiting_payment',
      quote: buildQuote(s.amount, s.currency, this.opts.rateFiatPerBtc),
      destination:
        s.rail === 'lightning_address' && payee.lightningAddress
          ? payee.lightningAddress
          : `lnbc${Math.round(s.amount / 9)}n1sim${s.id.replace(/[^a-z0-9]/g, '').slice(-24)}`,
    });

    await sleep(this.opts.stepMs);
    this.repo.updateSettlement(s.id, { status: 'in_flight' });

    await sleep(this.opts.settleDelayMs);
    if (this.opts.alwaysFail) {
      this.repo.updateSettlement(s.id, { status: 'failed', failureReason: 'No route found to the recipient.' });
    } else {
      this.repo.updateSettlement(s.id, { status: 'confirmed', preimage: randomBytes(32).toString('hex') });
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
