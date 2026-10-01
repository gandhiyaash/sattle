/**
 * Small pure helpers both sides of the pay-link and wallet contracts use.
 */

import type { GuestSettlement, Settlement } from './types';

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
