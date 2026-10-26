/**
 * Small pure helpers both sides of the pay-link and wallet contracts use.
 */

import { LEDGER_STATUSES, type GuestSettlement, type PayLink, type Settlement } from './types';

/** What a payee's NWC connection must grant. Nothing that can spend. */
export const NWC_REQUIRED_METHODS = ['make_invoice', 'lookup_invoice'] as const;

/** Methods the server never needs; granting them is flagged to the user. */
export const NWC_SPEND_METHODS = ['pay_invoice', 'pay_keysend', 'multi_pay_invoice', 'multi_pay_keysend'] as const;

export const payLinkPath = (token: string) => `/s/${token}`;

/** Strips everything the guest page must not see. */
export function toGuestSettlement(s: Settlement): GuestSettlement {
  return {
    id: s.id,
    amount: s.amount,
    currency: s.currency,
    status: s.status,
    quote: s.quote,
    destination: s.destination,
    preimage: s.preimage,
    failureReason: s.failureReason,
    updatedAt: s.updatedAt,
  };
}

/**
 * What settled a link's debt without going through the link: the person owed
 * marked it settled, a UPI payment made from the app was confirmed, or
 * another link for the same debt was paid. The latest settlement between the
 * link's two people, made since the link was, for at least what it asks; a
 * part payment leaves the link expired, not settled. A link pays once, so
 * this holds even if they owe each other again later: that takes a new link.
 */
export function settledOutsideLink(settlements: Settlement[], link: PayLink): Settlement | undefined {
  return settlements
    .filter(
      (s) =>
        LEDGER_STATUSES.includes(s.status) &&
        s.fromMemberId === link.fromMemberId &&
        s.toMemberId === link.toMemberId &&
        s.amount >= link.amount &&
        s.createdAt >= link.createdAt
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
}
