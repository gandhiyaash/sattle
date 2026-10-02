import { describe, expect, it, vi } from 'vitest';

import { createRateService } from './rates';

const ok = (inr: number) => new Response(JSON.stringify({ bitcoin: { inr } }), { status: 200 });

function setup(responses: Array<Response | Error>) {
  let t = 1_000_000;
  const fetch = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const rates = createRateService({ fallback: { INR: 9_000_000 }, fetch: fetch as typeof globalThis.fetch, now: () => t });
  return { rates, fetch, advance: (ms: number) => (t += ms) };
}

describe('rates', () => {
  it('fetches live, then serves the cache for 30s', async () => {
    const { rates, fetch, advance } = setup([ok(8_500_000), ok(8_600_000)]);
    expect(await rates.rate('INR')).toMatchObject({ rateFiatPerBtc: 8_500_000, source: 'live' });
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
    const { rates } = setup([new Error('offline')]);
    await expect(rates.rate('USD')).rejects.toThrow('No fallback rate configured for USD');
  });
});
