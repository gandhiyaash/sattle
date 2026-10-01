/**
 * Fiat → sats at a pinned rate. Shared by the server and the mock so both
 * quote the same way.
 */

import type { Currency, Quote } from './types';

export const QUOTE_TTL_MS = 90_000;

export function buildQuote(
  amountFiat: number,
  currency: Currency,
  rateFiatPerBtc: number,
  now = Date.now()
): Quote {
  // amountFiat is minor units; 1 BTC = 1e8 sats.
  const amountSat = Math.round((amountFiat / 100 / rateFiatPerBtc) * 1e8);
  return {
    amountFiat,
    currency,
    amountSat,
    feeSat: Math.max(2, Math.round(amountSat * 0.003)),
    rateFiatPerBtc,
    expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
  };
}
