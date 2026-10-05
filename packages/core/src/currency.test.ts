import { describe, expect, it } from 'vitest';

import { amountAsTyped, formatAmount, formatFiat, formatSats, isSupportedCurrency, parseAmount } from './currency';

describe('formatFiat', () => {
  it('formats rupees in Indian grouping', () => {
    expect(formatFiat(12000000)).toBe('₹1,20,000');
    expect(formatFiat(150)).toBe('₹1.50');
  });
});

describe('formatAmount', () => {
  it('shows a rupee group in rupees', () => {
    expect(formatAmount(120_000, 'INR')).toBe('₹1,200');
    expect(formatAmount(120_000)).toBe('₹1,200');
  });

  it('shows a bitcoin group in whole sats, never as a fraction of a coin', () => {
    expect(formatAmount(15_000, 'BTC')).toBe('15,000 sats');
    expect(formatAmount(100_000_000, 'BTC')).toBe('100,000,000 sats');
  });
});

describe('formatSats', () => {
  it('says "sat" for one and "sats" for everything else', () => {
    expect(formatSats(1)).toBe('1 sat');
    expect(formatAmount(1, 'BTC')).toBe('1 sat');
    expect(formatSats(0)).toBe('0 sats');
    expect(formatSats(2)).toBe('2 sats');
    expect(formatSats(1_001)).toBe('1,001 sats');
  });

  it('goes by the whole number shown, not the one passed in', () => {
    expect(formatSats(1.2)).toBe('1 sat');
    expect(formatSats(1.6)).toBe('2 sats');
  });
});

describe('parseAmount', () => {
  it('reads rupees into paise', () => {
    expect(parseAmount('1200', 'INR')).toBe(120_000);
    expect(parseAmount('12.5', 'INR')).toBe(1_250);
    expect(parseAmount('₹1,200.75', 'INR')).toBe(120_075);
  });

  it('reads sats as they are', () => {
    expect(parseAmount('15000', 'BTC')).toBe(15_000);
    expect(parseAmount('15,000 sats', 'BTC')).toBe(15_000);
  });

  it('is nothing for what isn’t a number', () => {
    expect(parseAmount('', 'INR')).toBe(0);
    expect(parseAmount('abc', 'BTC')).toBe(0);
    expect(parseAmount('1.2.3', 'INR')).toBe(0);
  });

  it('reads back what amountAsTyped wrote, so an edit opens on the amount saved', () => {
    for (const [minor, currency] of [[120_075, 'INR'], [120_000, 'INR'], [15_000, 'BTC']] as const) {
      expect(parseAmount(amountAsTyped(minor, currency), currency)).toBe(minor);
    }
    expect(amountAsTyped(120_000, 'INR')).toBe('1200');
    expect(amountAsTyped(15_000, 'BTC')).toBe('15000');
  });
});

describe('isSupportedCurrency', () => {
  it('knows rupees and bitcoin, and nothing else', () => {
    expect(isSupportedCurrency('INR')).toBe(true);
    expect(isSupportedCurrency('BTC')).toBe(true);
    expect(isSupportedCurrency('USD')).toBe(false);
    expect(isSupportedCurrency(undefined)).toBe(false);
  });
});
