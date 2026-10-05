/**
 * Fiat per BTC, for pinning a quote. Several live sources tried in turn, a
 * 30s cache, and the last good rate when every source is down, so one
 * provider's outage never blocks a payment.
 *
 * Order of preference:
 *   cache       fetched in the last 30s
 *   live        fetched just now, from the first source that answered
 *   stale       every source failed; the last rate one gave us, however old
 *   fallback    no source has ever answered; a fixed rate, only if one is configured
 *
 * With no fixed rate configured (the default), a currency no source has ever
 * priced can't be quoted: better to fail and say so than to make up a price.
 *
 * The sources are global prices, not Indian exchanges, which trade a few
 * percent above them. A quote is only good for 90s anyway (QUOTE_TTL_MS).
 */

import type { RateSource as QuoteRateSource } from '@sattle/core';

export type RateSource = 'cache' | 'live' | 'stale' | 'fallback';

export interface Rate {
  currency: string;
  rateFiatPerBtc: number;
  source: RateSource;
  /** Who gave it, e.g. "CoinGecko". Absent for the fixed fallback. */
  provider?: string;
  /** When the rate was fetched from the source. Absent for the fixed fallback. */
  fetchedAt?: string;
}

/** Somewhere to read a price from. Throws, or returns a non-positive number, when it has none. */
export interface PriceSource {
  name: string;
  url: (code: string) => string;
  read: (body: unknown, code: string) => unknown;
}

type Json = Record<string, any>;

/**
 * In the order they're tried. All three price most currencies, INR included, without a key.
 * Coinbase is last: its INR price runs a few percent above the other two.
 */
export const PRICE_SOURCES: PriceSource[] = [
  {
    name: 'CoinGecko',
    url: (code) => `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${code.toLowerCase()}`,
    read: (body, code) => (body as Json).bitcoin?.[code.toLowerCase()],
  },
  {
    name: 'Blockchain.com',
    url: () => 'https://blockchain.info/ticker',
    read: (body, code) => (body as Json)[code]?.last,
  },
  {
    name: 'Coinbase',
    url: (code) => `https://api.coinbase.com/v2/prices/BTC-${code}/spot`,
    // A string, to keep its decimals.
    read: (body) => Number((body as Json).data?.amount),
  },
];

export interface RateService {
  /** Doesn't throw when the source is down. Throws only for a currency with no fallback configured. */
  rate(currency: string): Promise<Rate>;
}

export interface RateOptions {
  /** Fixed rates by currency code, used only when no source has ever answered. None by default. */
  fallback?: Record<string, number>;
  sources?: PriceSource[];
  ttlMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export const RATE_TTL_MS = 30_000;

export function createRateService(opts: RateOptions = {}): RateService {
  const ttlMs = opts.ttlMs ?? RATE_TTL_MS;
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const sources = opts.sources ?? PRICE_SOURCES;

  const last = new Map<string, { rate: number; provider: string; at: number }>();
  // One lookup per currency at a time; everyone waiting shares its answer.
  const pending = new Map<string, Promise<{ rate: number; provider: string }>>();

  async function ask(source: PriceSource, code: string): Promise<number> {
    const res = await doFetch(source.url(code), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    const rate = source.read(await res.json(), code);
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) throw new Error(`gave no usable ${code} rate`);
    return rate;
  }

  async function fetchLive(code: string): Promise<{ rate: number; provider: string }> {
    const failures: string[] = [];
    for (const source of sources) {
      try {
        return { rate: await ask(source, code), provider: source.name };
      } catch (e) {
        failures.push(`${source.name} ${e instanceof Error ? e.message : e}`);
      }
    }
    throw new Error(failures.join('; '));
  }

  return {
    async rate(currency) {
      const code = currency.toUpperCase();
      const cached = last.get(code);
      if (cached && now() - cached.at < ttlMs) {
        return { currency: code, rateFiatPerBtc: cached.rate, source: 'cache', provider: cached.provider, fetchedAt: iso(cached.at) };
      }

      let inFlight = pending.get(code);
      if (!inFlight) {
        inFlight = fetchLive(code).finally(() => pending.delete(code));
        pending.set(code, inFlight);
      }

      try {
        const { rate, provider } = await inFlight;
        const at = now();
        last.set(code, { rate, provider, at });
        return { currency: code, rateFiatPerBtc: rate, source: 'live', provider, fetchedAt: iso(at) };
      } catch (e) {
        console.warn(`rates: every ${code} source failed (${e instanceof Error ? e.message : e})`);
        if (cached) {
          return { currency: code, rateFiatPerBtc: cached.rate, source: 'stale', provider: cached.provider, fetchedAt: iso(cached.at) };
        }
        const fixed = opts.fallback?.[code];
        if (fixed === undefined) throw new RateUnavailableError(code);
        return { currency: code, rateFiatPerBtc: fixed, source: 'fallback' };
      }
    },
  };
}

/** No source could price the currency, and there's no earlier rate to fall back on. */
export class RateUnavailableError extends Error {
  constructor(readonly currency: string) {
    super(`No price source answered for ${currency}.`);
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

/** What the payer is told about a rate. Cache and live are both the market: at most 30s apart. */
export function quoteRateSource(rate: Rate): QuoteRateSource {
  switch (rate.source) {
    case 'cache':
    case 'live':
      return { kind: 'market', provider: rate.provider, fetchedAt: rate.fetchedAt };
    case 'stale':
      return { kind: 'stale', provider: rate.provider, fetchedAt: rate.fetchedAt };
    case 'fallback':
      return { kind: 'fallback' };
  }
}
