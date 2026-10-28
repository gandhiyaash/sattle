import { describe, expect, it } from 'vitest';

import {
  amountAsTyped,
  conversionRate,
  convertForeign,
  currencySymbol,
  foreignCurrenciesFor,
  formatAmount,
  formatFiat,
  formatConversion,
  formatSats,
  isSupportedCurrency,
  parseAmount,
} from './currency';

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

describe('spending in another currency', () => {
  it('prices a dollar in paise through what each pays for a bitcoin', () => {
    // ₹88,00,000 and $1,00,000 a bitcoin: a dollar is ₹88.
    expect(conversionRate('USD', 100_000, 'INR', 8_800_000)).toBe(8_800);
  });

  it('prices a dollar in sats for a group kept in bitcoin, with no second price', () => {
    expect(conversionRate('USD', 100_000, 'BTC')).toBe(1_000);
  });

  it('refuses a price it cannot use rather than make one up', () => {
    expect(() => conversionRate('USD', 0, 'INR', 8_800_000)).toThrow();
    expect(() => conversionRate('USD', 100_000, 'INR')).toThrow();
  });

  it('converts what was paid into the group’s smallest unit', () => {
    // $12.50 at ₹88 a dollar is ₹1,100.
    expect(convertForeign({ currency: 'USD', amount: 1_250, rate: 8_800 })).toBe(110_000);
    // Yen are typed whole: ¥1,500 at 59 paise a yen.
    expect(convertForeign({ currency: 'JPY', amount: 1_500, rate: 59 })).toBe(88_500);
  });

  it('types and shows yen whole, and baht with satang', () => {
    expect(parseAmount('1500', 'JPY')).toBe(1_500);
    expect(parseAmount('12.5', 'THB')).toBe(1_250);
    expect(formatFiat(1_500, 'JPY')).toBe('¥1,500');
  });

  it('says what a rate is in words people check against a receipt', () => {
    expect(formatConversion('USD', 8_812, 'INR')).toBe('1 USD = ₹88.12');
    expect(formatConversion('USD', 1_123, 'BTC')).toBe('1 USD = 1,123 sats');
  });

  it('gives each currency the sign on its receipts', () => {
    expect(currencySymbol('INR')).toBe('₹');
    expect(currencySymbol('USD')).toBe('$');
    expect(currencySymbol('THB')).toBe('฿');
    expect(currencySymbol('BTC')).toBe('sats');
  });

  it('never offers the group’s own currency as a foreign one', () => {
    expect(foreignCurrenciesFor('INR')).not.toContain('INR');
    expect(foreignCurrenciesFor('BTC')).toContain('INR');
  });
});
