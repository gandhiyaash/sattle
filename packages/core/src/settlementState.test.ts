import { describe, expect, it } from 'vitest';

import { isInProgress, liveInvoiceFor } from './settlementState';
import type { Quote, Settlement, SettlementStatus } from './types';

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

describe('liveInvoiceFor', () => {
  const debt = { fromMemberId: 'm-om', toMemberId: 'm-yash', amount: 1000 };
  const settlement = (over: Partial<Settlement>): Settlement => ({
    id: 's-1',
    groupId: 'g-1',
    ...debt,
    currency: 'INR',
    rail: 'invoice',
    status: 'awaiting_payment',
    quote: quote(60_000),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('finds the invoice still out for the debt, whether or not it has been minted yet', () => {
    const out = settlement({});
    expect(liveInvoiceFor([settlement({ id: 's-0', status: 'expired' }), out], debt)).toBe(out);
    const minting = settlement({ status: 'created', quote: undefined });
    expect(liveInvoiceFor([minting], debt)).toBe(minting);
  });

  it('passes over one that has lapsed or finished, so a new one is asked for', () => {
    expect(liveInvoiceFor([settlement({ quote: quote(-1_000) })], debt)).toBeUndefined();
    expect(liveInvoiceFor([settlement({ status: 'confirmed' })], debt)).toBeUndefined();
    expect(liveInvoiceFor([settlement({ status: 'failed' })], debt)).toBeUndefined();
  });

  it('passes over another pair’s, the other direction, and a payment that isn’t an invoice', () => {
    expect(liveInvoiceFor([settlement({ toMemberId: 'm-priya' })], debt)).toBeUndefined();
    expect(liveInvoiceFor([settlement({ fromMemberId: 'm-yash', toMemberId: 'm-om' })], debt)).toBeUndefined();
    expect(liveInvoiceFor([settlement({ rail: 'in_app', status: 'in_flight' })], debt)).toBeUndefined();
  });

  it('passes over one for a different amount: the debt has changed since', () => {
    expect(liveInvoiceFor([settlement({ amount: 600 })], debt)).toBeUndefined();
  });
});
