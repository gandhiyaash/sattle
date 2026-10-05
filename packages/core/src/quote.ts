/**
 * What a debt comes to in sats. Shared by the server and the mock so both
 * quote the same way.
 *
 * A rupee debt is converted at a pinned rate. A debt in a group kept in
 * bitcoin is in sats already, so there is nothing to convert.
 */

import { isBitcoin } from './currency';
import type { Currency, Quote, RateSource } from './types';

export const QUOTE_TTL_MS = 90_000;

/** `rateFiatPerBtc` and `rateSource` are for a fiat debt. A bitcoin one ignores the rate. */
export function buildQuote(
  amount: number,
  currency: Currency,
  rateFiatPerBtc: number,
  rateSource: RateSource,
  now = Date.now()
): Quote {
  if (isBitcoin(currency)) return buildSatsQuote(amount, now, rateSource);
  // amount is minor units; 1 BTC = 1e8 sats.
  const amountSat = Math.round((amount / 100 / rateFiatPerBtc) * 1e8);
  return {
    amountFiat: amount,
    currency,
    amountSat,
    feeSat: feeFor(amountSat),
    rateFiatPerBtc,
    rateSource,
    expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
  };
}

/**
 * The quote for a debt in a group kept in bitcoin: the sats owed are the sats
 * to pay. No rate was used, so none is named, and one bitcoin is one bitcoin.
 * It still runs out, because the invoice made from it does.
 *
 * `rateSource` is kept only when it says the payment is simulated, which is
 * true whatever the currency and is how the payer is told.
 */
export function buildSatsQuote(amountSat: number, now = Date.now(), rateSource?: RateSource): Quote {
  return {
    amountFiat: amountSat,
    currency: 'BTC',
    amountSat,
    feeSat: feeFor(amountSat),
    rateFiatPerBtc: 1,
    ...(rateSource?.kind === 'demo' ? { rateSource } : {}),
    expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
  };
}

const feeFor = (amountSat: number) => Math.max(2, Math.round(amountSat * 0.003));

/** "1 BTC = ₹90,00,000", whole units: paise on a bitcoin price is noise. */
export function formatRate(q: Pick<Quote, 'rateFiatPerBtc' | 'currency'>): string {
  const price = new Intl.NumberFormat(q.currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency: q.currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(q.rateFiatPerBtc);
  return `1 BTC = ${price}`;
}

/** Where the rate came from, short enough for one row of a breakdown. */
export function describeRateSource(source: RateSource | undefined, now = Date.now()): string | undefined {
  if (!source) return undefined;
  const from = source.provider ?? 'Price feed';
  switch (source.kind) {
    case 'market':
      return `${from}, live`;
    case 'stale': {
      const age = source.fetchedAt ? ago(Date.parse(source.fetchedAt), now) : undefined;
      return `${from}, ${age ?? 'last known'}. Live price unavailable`;
    }
    case 'fallback':
      return 'Standard rate. Live price unavailable';
    case 'demo':
      return 'Demo rate. No real money moves';
  }
}

function ago(then: number, now: number): string | undefined {
  if (Number.isNaN(then)) return undefined;
  const min = Math.round((now - then) / 60_000);
  if (min < 1) return 'under a minute ago';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
