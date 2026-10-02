/**
 * Fiat per BTC, for pinning a quote. One live source, a 30s cache, and a
 * fixed rate when the source is down, so quoting never blocks on it.
 *
 * Order of preference:
 *   cache       fetched in the last 30s
 *   live        fetched just now
 *   stale       the source failed; the last rate it gave us, however old
 *   fallback    the source has never answered; the configured fixed rate
 *
 * A quote is only good for 90s anyway (QUOTE_TTL_MS), so a rate from a few
 * minutes ago is still closer to the truth than a hard-coded one.
 */

export type RateSource = 'cache' | 'live' | 'stale' | 'fallback';

export interface Rate {
  currency: string;
  rateFiatPerBtc: number;
  source: RateSource;
  /** When the rate was fetched from the source. Absent for the fixed fallback. */
  fetchedAt?: string;
}

export interface RateService {
  /** Doesn't throw when the source is down. Throws only for a currency with no fallback configured. */
  rate(currency: string): Promise<Rate>;
}

export interface RateOptions {
  /** Fixed rates by currency code (INR → 9_000_000). Required for any currency we quote in. */
  fallback: Record<string, number>;
  ttlMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export const RATE_TTL_MS = 30_000;
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=';

export function createRateService(opts: RateOptions): RateService {
  const ttlMs = opts.ttlMs ?? RATE_TTL_MS;
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;

  const last = new Map<string, { rate: number; at: number }>();
  // One request per currency at a time; everyone waiting shares its answer.
  const pending = new Map<string, Promise<number>>();

  async function fetchLive(code: string): Promise<number> {
    const res = await doFetch(COINGECKO + code.toLowerCase(), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`rate source answered ${res.status}`);
    const body = (await res.json()) as { bitcoin?: Record<string, unknown> };
    const rate = body.bitcoin?.[code.toLowerCase()];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(`rate source gave no usable ${code} rate`);
    }
    return rate;
  }

  return {
    async rate(currency) {
      const code = currency.toUpperCase();
      const cached = last.get(code);
      if (cached && now() - cached.at < ttlMs) {
        return { currency: code, rateFiatPerBtc: cached.rate, source: 'cache', fetchedAt: iso(cached.at) };
      }

      let inFlight = pending.get(code);
      if (!inFlight) {
        inFlight = fetchLive(code).finally(() => pending.delete(code));
        pending.set(code, inFlight);
      }

      try {
        const rate = await inFlight;
        const at = now();
        last.set(code, { rate, at });
        return { currency: code, rateFiatPerBtc: rate, source: 'live', fetchedAt: iso(at) };
      } catch (e) {
        console.warn(`rates: ${code} lookup failed (${e instanceof Error ? e.message : e})`);
        if (cached) return { currency: code, rateFiatPerBtc: cached.rate, source: 'stale', fetchedAt: iso(cached.at) };
        const fixed = opts.fallback[code];
        if (fixed === undefined) throw new Error(`No fallback rate configured for ${code}.`);
        return { currency: code, rateFiatPerBtc: fixed, source: 'fallback' };
      }
    },
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
