import { describe, expect, it } from 'vitest';

import { buildQuote, buildSatsQuote, describeRateSource, formatRate } from './quote';

describe('buildQuote', () => {
  it('pins the sats, the rate and where the rate came from', () => {
    const q = buildQuote(33_333, 'INR', 9_000_000, { kind: 'demo' }, 0);
    // ₹333.33 at ₹90,00,000/BTC = 3,703.67 sats.
    expect(q).toMatchObject({ amountSat: 3_704, feeSat: 11, rateSource: { kind: 'demo' } });
    expect(q.expiresAt).toBe('1970-01-01T00:01:30.000Z');
  });

  it('converts nothing for a group kept in bitcoin: the sats owed are the sats to pay', () => {
    // The rate passed in is the rupee one. A bitcoin debt must not be run through it.
    const q = buildQuote(15_000, 'BTC', 9_000_000, { kind: 'market', provider: 'CoinGecko' }, 0);
    expect(q).toMatchObject({ amountFiat: 15_000, currency: 'BTC', amountSat: 15_000, feeSat: 45, rateFiatPerBtc: 1 });
    // No rate was used, so none is named.
    expect(q.rateSource).toBeUndefined();
    expect(q.expiresAt).toBe('1970-01-01T00:01:30.000Z');
  });

  it('still says a bitcoin payment is simulated when it is', () => {
    expect(buildQuote(15_000, 'BTC', 9_000_000, { kind: 'demo' }, 0).rateSource).toEqual({ kind: 'demo' });
  });
});

describe('buildSatsQuote', () => {
  it('needs no rate at all', () => {
    expect(buildSatsQuote(21, 0)).toEqual({
      amountFiat: 21,
      currency: 'BTC',
      amountSat: 21,
      feeSat: 2,
      rateFiatPerBtc: 1,
      expiresAt: '1970-01-01T00:01:30.000Z',
    });
  });
});

describe('formatRate', () => {
  it('groups rupees the Indian way, with no paise', () => {
    expect(formatRate({ currency: 'INR', rateFiatPerBtc: 9_000_000 })).toBe('1 BTC = ₹90,00,000');
    expect(formatRate({ currency: 'INR', rateFiatPerBtc: 10_234_567.89 })).toBe('1 BTC = ₹1,02,34,568');
  });

  it('uses Western grouping for other currencies', () => {
    expect(formatRate({ currency: 'USD', rateFiatPerBtc: 104_250 })).toBe('1 BTC = $104,250');
  });
});

describe('describeRateSource', () => {
  const now = Date.parse('2026-10-05T10:00:00.000Z');

  it('names the provider of a market rate', () => {
    expect(describeRateSource({ kind: 'market', provider: 'CoinGecko' }, now)).toBe('CoinGecko, live');
  });

  it('says how old a stale rate is', () => {
    const fetchedAt = '2026-10-05T09:48:00.000Z';
    expect(describeRateSource({ kind: 'stale', provider: 'CoinGecko', fetchedAt }, now)).toBe(
      'CoinGecko, 12 min ago. Live price unavailable'
    );
  });

  it('flags fixed rates, and says nothing for quotes made before sources were recorded', () => {
    expect(describeRateSource({ kind: 'fallback' }, now)).toBe('Standard rate. Live price unavailable');
    expect(describeRateSource({ kind: 'demo' }, now)).toBe('Demo rate. No real money moves');
    expect(describeRateSource(undefined, now)).toBeUndefined();
  });
});
