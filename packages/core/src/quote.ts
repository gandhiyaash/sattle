/**
 * Fiat → sats at a pinned rate. Shared by the server and the mock so both
 * quote the same way.
 */

import type { Currency, Quote, RateSource } from './types';

export const QUOTE_TTL_MS = 90_000;

export function buildQuote(
  amountFiat: number,
  currency: Currency,
  rateFiatPerBtc: number,
  rateSource: RateSource,
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
    rateSource,
    expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
  };
}

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
