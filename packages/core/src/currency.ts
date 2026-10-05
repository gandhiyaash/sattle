/**
 * The currencies a group can be kept in, and how an amount in each is typed
 * and shown.
 *
 * Every amount is a whole number of the currency's smallest unit: paise for
 * rupees, sats for bitcoin. A bitcoin group is counted in sats from end to
 * end. That is the unit people who use it think in, and whole coins would
 * put eight decimals on a dinner.
 */

/** What the app offers. The first is what a group was kept in before there was a choice. */
export const SUPPORTED_CURRENCIES = ['INR', 'BTC'] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const BITCOIN = 'BTC';

export const isBitcoin = (currency: string) => currency === BITCOIN;

export const isSupportedCurrency = (value: unknown): value is SupportedCurrency =>
  SUPPORTED_CURRENCIES.includes(value as SupportedCurrency);

/** ₹1,200 rather than ₹1,200.00; paise shown only when there are some. */
export function formatFiat(minor: number, currency = 'INR'): string {
  const major = minor / 100;
  const hasFraction = minor % 100 !== 0;
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(major);
}

/** "15,000 sats", and "1 sat" for the one amount that isn't plural. */
export function formatSats(sats: number): string {
  const whole = Math.round(sats);
  return `${new Intl.NumberFormat('en-US').format(whole)} ${Math.abs(whole) === 1 ? 'sat' : 'sats'}`;
}

/** An amount in a group's own currency: "₹1,200", or "15,000 sats" for a group kept in bitcoin. */
export function formatAmount(minor: number, currency = 'INR'): string {
  return isBitcoin(currency) ? formatSats(minor) : formatFiat(minor, currency);
}

/** How many of the smallest unit make one of what people type. Rupees are typed with paise after the point; sats as they are. */
const minorPerTyped = (currency: string) => (isBitcoin(currency) ? 1 : 100);

/** An amount as typed, in minor units; 0 for anything that isn't a clean number. */
export function parseAmount(text: string, currency = 'INR'): number {
  const n = Number(text.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * minorPerTyped(currency)) : 0;
}

/** The reverse, for a field that opens on an amount already saved. */
export const amountAsTyped = (minor: number, currency = 'INR') => String(minor / minorPerTyped(currency));
