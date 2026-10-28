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

/**
 * Currencies an expense can be spent in on a trip, besides the group's own. Spent in one, it is
 * kept in the group's currency at the day's rate, with what was actually paid beside it
 * (ForeignAmount). Rupees are one too, for a group kept in bitcoin.
 */
export const TRIP_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'AED', 'SGD', 'THB', 'MYR', 'IDR', 'VND', 'JPY', 'LKR', 'NPR', 'AUD', 'CAD', 'INR',
] as const;

/** The ones an expense in this group can be spent in: every trip currency but the group's own. */
export const foreignCurrenciesFor = (groupCurrency: string): string[] =>
  TRIP_CURRENCIES.filter((c) => c !== groupCurrency);

/** Nobody counts these in hundredths: a yen, a dong or a rupiah is typed whole, like a sat. */
const WHOLE = new Set(['BTC', 'JPY', 'VND', 'IDR']);

/** ₹1,200 rather than ₹1,200.00; paise shown only when there are some. */
export function formatFiat(minor: number, currency = 'INR'): string {
  const per = minorPerTyped(currency);
  const major = minor / per;
  const hasFraction = minor % per !== 0;
  const options: Intl.NumberFormatOptions = {
    style: 'currency',
    currency,
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  };
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  try {
    // ฿400 and $12, not THB 400 and US$12: on a trip, the receipt's own sign.
    return new Intl.NumberFormat(locale, { ...options, currencyDisplay: 'narrowSymbol' }).format(major);
  } catch {
    // An engine without narrow symbols says the code instead.
    return new Intl.NumberFormat(locale, options).format(major);
  }
}

/** The sign typed beside an amount: ₹, $, ฿, or "sats". A currency with no sign of its own gives its code. */
export function currencySymbol(currency: string): string {
  if (isBitcoin(currency)) return 'sats';
  return formatFiat(0, currency).replace(/[\d.,\s\u00a0]/g, '') || currency;
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
export const minorPerTyped = (currency: string) => (WHOLE.has(currency) ? 1 : 100);

/**
 * What one whole unit of `from` (a dollar, a baht) is worth in the smallest unit of `to`, the
 * group's currency, given each one's price of a bitcoin. Bitcoin is the one price every source
 * quotes in every currency, so dollars to rupees goes through it. A group kept in bitcoin
 * needs only the one price: sats are a hundred-millionth of a bitcoin.
 */
export function conversionRate(from: string, fromPerBtc: number, to: string, toPerBtc?: number): number {
  const perUnit = isBitcoin(to) ? SATS_PER_BTC / fromPerBtc : ((toPerBtc ?? NaN) / fromPerBtc) * minorPerTyped(to);
  if (!Number.isFinite(perUnit) || perUnit <= 0) throw new Error(`No rate from ${from} to ${to}.`);
  // Six significant figures: past that, the price sources disagree anyway.
  return Number(perUnit.toPrecision(6));
}

const SATS_PER_BTC = 100_000_000;

/** An amount spent in another currency, in the group's: what `original` came to at its rate. */
export const convertForeign = (original: { currency: string; amount: number; rate: number }): number =>
  Math.round((original.amount / minorPerTyped(original.currency)) * original.rate);

/**
 * What's wrong with an expense's original, for a group kept in `groupCurrency`, or null when
 * nothing is. The server and the mock both refuse what this names.
 */
export function foreignAmountProblem(
  amount: number,
  original: { currency: string; amount: number; rate: number } | undefined,
  groupCurrency: string
): string | null {
  if (!original) return null;
  if (!foreignCurrenciesFor(groupCurrency).includes(original.currency)) {
    return `An expense here can’t be paid in ${original.currency}.`;
  }
  if (!Number.isInteger(original.amount) || original.amount <= 0 || !(original.rate > 0)) {
    return 'Enter what was paid.';
  }
  // What everyone owes is what was paid at that rate, so the two can't tell different stories.
  if (convertForeign(original) !== amount) return 'The amount doesn’t match what was paid at that rate.';
  return null;
}

/** "1 USD = ₹88.12", or "1 USD = 1,123 sats" in a group kept in bitcoin. */
export function formatConversion(from: string, rate: number, to: string): string {
  const shown = isBitcoin(to) ? formatSats(rate) : formatFiat(Math.round(rate), to);
  return `1 ${from} = ${shown}`;
}

/** An amount as typed, in minor units; 0 for anything that isn't a clean number. */
export function parseAmount(text: string, currency = 'INR'): number {
  const n = Number(text.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * minorPerTyped(currency)) : 0;
}

/** The reverse, for a field that opens on an amount already saved. */
export const amountAsTyped = (minor: number, currency = 'INR') => String(minor / minorPerTyped(currency));
