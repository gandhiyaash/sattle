import { describe, expect, it } from 'vitest';

import { isInProgress } from './settlementState';
import type { Quote, SettlementStatus } from './types';

const quote = (expiresInMs: number): Quote => ({
  amountFiat: 1000,
  currency: 'INR',
  amountSat: 111,
  feeSat: 1,
  rateFiatPerBtc: 9_000_000,
  expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
});

describe('isInProgress', () => {
  it('is true until a payment reaches an end state', () => {
    const states: Array<[SettlementStatus, boolean]> = [
      ['created', true],
      ['awaiting_payment', true],
      ['in_flight', true],
      ['confirmed', false],
      ['manually_confirmed', false],
      ['failed', false],
      ['expired', false],
    ];
    for (const [status, expected] of states) expect([status, isInProgress({ status })]).toEqual([status, expected]);
  });

  it('stops counting an invoice once its quote has lapsed, even before the server marks it expired', () => {
    expect(isInProgress({ status: 'awaiting_payment', quote: quote(60_000) })).toBe(true);
    expect(isInProgress({ status: 'awaiting_payment', quote: quote(-1_000) })).toBe(false);
    // Money already moving isn't abandoned because the quote ran out.
    expect(isInProgress({ status: 'in_flight', quote: quote(-1_000) })).toBe(true);
  });
});
