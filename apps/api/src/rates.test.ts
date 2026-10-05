import { describe, expect, it, vi } from 'vitest';

import { createRateService, PRICE_SOURCES, quoteRateSource, RateUnavailableError, type RateOptions } from './rates';

const ok = (inr: number) => new Response(JSON.stringify({ bitcoin: { inr } }), { status: 200 });
const down = () => new Error('offline');

/** Answers in order, one per request, whichever source asks. */
function setup(responses: Array<Response | Error>, opts: Partial<RateOptions> = { fallback: { INR: 9_000_000 } }) {
  let t = 1_000_000;
  const fetch = vi.fn(async (_url: string) => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  // CoinGecko's shape only, unless a test brings its own sources.
  const rates = createRateService({
    sources: [PRICE_SOURCES[0]!],
    ...opts,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => t,
  });
  return { rates, fetch, advance: (ms: number) => (t += ms) };
}

describe('rates', () => {
  it('fetches live, then serves the cache for 30s', async () => {
    const { rates, fetch, advance } = setup([ok(8_500_000), ok(8_600_000)]);
    expect(await rates.rate('INR')).toMatchObject({ rateFiatPerBtc: 8_500_000, source: 'live', provider: 'CoinGecko' });
    advance(29_999);
    expect(await rates.rate('inr')).toMatchObject({ rateFiatPerBtc: 8_500_000, source: 'cache', currency: 'INR' });
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(1);
    expect(await rates.rate('INR')).toMatchObject({ rateFiatPerBtc: 8_600_000, source: 'live' });
  });

  it('uses the fixed rate when the source has never answered', async () => {
    const { rates } = setup([new Error('offline')]);
    const r = await rates.rate('INR');
    expect(r).toEqual({ currency: 'INR', rateFiatPerBtc: 9_000_000, source: 'fallback' });
  });

  it('prefers the last live rate over the fixed one when the source goes down', async () => {
    const { rates, advance } = setup([ok(8_500_000), new Response('busy', { status: 429 })]);
    await rates.rate('INR');
    advance(60_000);
    expect(await rates.rate('INR')).toMatchObject({ rateFiatPerBtc: 8_500_000, source: 'stale' });
  });

  it('rejects a nonsense rate', async () => {
    const { rates } = setup([new Response(JSON.stringify({ bitcoin: { inr: 0 } }), { status: 200 })]);
    expect(await rates.rate('INR')).toMatchObject({ source: 'fallback' });
  });

  it('shares one request between callers who arrive together', async () => {
    const { rates, fetch } = setup([ok(8_500_000)]);
    const [a, b] = await Promise.all([rates.rate('INR'), rates.rate('INR')]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a.rateFiatPerBtc).toBe(b.rateFiatPerBtc);
  });

  it('refuses a currency it has no fallback for, once the source fails', async () => {
    const { rates } = setup([down()]);
    await expect(rates.rate('USD')).rejects.toBeInstanceOf(RateUnavailableError);
  });
});

describe('rates from more than one source', () => {
  const coinbase = (amount: string) => new Response(JSON.stringify({ data: { amount, base: 'BTC', currency: 'INR' } }));
  const blockchain = (last: number) => new Response(JSON.stringify({ INR: { last, symbol: 'INR' } }));

  it('asks the next source when one is down, and says which one answered', async () => {
    const { rates, fetch } = setup([down(), blockchain(8_240_678.5)], { sources: PRICE_SOURCES });
    expect(await rates.rate('INR')).toMatchObject({ rateFiatPerBtc: 8_240_678.5, source: 'live', provider: 'Blockchain.com' });
    expect(fetch.mock.calls.map(([url]) => new URL(url).host)).toEqual(['api.coingecko.com', 'blockchain.info']);
  });

  it('gets to the last source past an error and a nonsense answer', async () => {
    const { rates } = setup([new Response('busy', { status: 429 }), blockchain(0), coinbase('8547116.25')], {
      sources: PRICE_SOURCES,
    });
    expect(await rates.rate('INR')).toMatchObject({ rateFiatPerBtc: 8_547_116.25, provider: 'Coinbase' });
  });

  it('keeps the provider with a stale rate', async () => {
    const { rates, advance } = setup([down(), blockchain(8_500_000), down(), down(), down()], { sources: PRICE_SOURCES });
    await rates.rate('INR');
    advance(60_000);
    expect(await rates.rate('INR')).toMatchObject({ rateFiatPerBtc: 8_500_000, source: 'stale', provider: 'Blockchain.com' });
  });

  it('makes up no price when every source is down and none has answered', async () => {
    const { rates } = setup([down(), down(), down()], { sources: PRICE_SOURCES });
    await expect(rates.rate('INR')).rejects.toBeInstanceOf(RateUnavailableError);
  });

  it('builds a URL for the currency asked about', () => {
    expect(PRICE_SOURCES.map((p) => p.url('INR'))).toEqual([
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=inr',
      'https://blockchain.info/ticker',
      'https://api.coinbase.com/v2/prices/BTC-INR/spot',
    ]);
  });
});

describe('quoteRateSource', () => {
  it('tells the payer a cached rate is still the market', () => {
    const fetchedAt = '2026-10-05T10:00:00.000Z';
    expect(quoteRateSource({ currency: 'INR', rateFiatPerBtc: 1, source: 'live', provider: 'Coinbase', fetchedAt })).toEqual({
      kind: 'market',
      provider: 'Coinbase',
      fetchedAt,
    });
    expect(quoteRateSource({ currency: 'INR', rateFiatPerBtc: 1, source: 'cache', fetchedAt }).kind).toBe('market');
  });

  it('never passes off a stale or fixed rate as live', () => {
    expect(quoteRateSource({ currency: 'INR', rateFiatPerBtc: 1, source: 'stale' }).kind).toBe('stale');
    expect(quoteRateSource({ currency: 'INR', rateFiatPerBtc: 1, source: 'fallback' })).toEqual({ kind: 'fallback' });
  });
});
