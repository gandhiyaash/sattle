/**
 * Which currencies someone uses. Nobody is asked: everyone starts with both,
 * and someone who only ever uses one can turn the other off under Account.
 *
 * It decides two things. A new group starts in `newGroups`. And the app only
 * shows the ways to pay that go with what they use: UPI with rupees,
 * Lightning with bitcoin (payWays in @sattle/core). With both, which is
 * where everyone starts, nothing is hidden.
 *
 * It is kept on this device and the server never sees it. It changes what
 * the app shows, not what anyone is allowed to do.
 *
 * Nothing here imports React Native, so it runs under vitest.
 */

import { SUPPORTED_CURRENCIES, isSupportedCurrency, type SupportedCurrency } from '@sattle/core';

export interface CurrencyPrefs {
  /** In the order the app lists them. Never empty. */
  uses: SupportedCurrency[];
  /** What a new group is kept in. One of `uses`. */
  newGroups: SupportedCurrency;
}

/** Where everyone starts, and stays unless they change it: nothing is hidden, and a new group opens in rupees. */
export const EVERY_CURRENCY: CurrencyPrefs = { uses: [...SUPPORTED_CURRENCIES], newGroups: SUPPORTED_CURRENCIES[0] };

/**
 * Turns one currency on or off. What new groups start in follows along: it
 * stays put while it is still one they use, and otherwise becomes one that is.
 * The last one stays on, since a group has to be kept in something.
 */
export function toggleCurrency(prefs: CurrencyPrefs, currency: SupportedCurrency): CurrencyPrefs {
  const on = !prefs.uses.includes(currency);
  const uses = SUPPORTED_CURRENCIES.filter((c) => (c === currency ? on : prefs.uses.includes(c)));
  if (uses.length === 0) return prefs;
  return { uses, newGroups: uses.includes(prefs.newGroups) ? prefs.newGroups : uses[0] };
}

/** Sets what new groups start in. Ignored for a currency they don't use. */
export function startNewGroupsIn(prefs: CurrencyPrefs, currency: SupportedCurrency): CurrencyPrefs {
  return prefs.uses.includes(currency) ? { ...prefs, newGroups: currency } : prefs;
}

export const serializeCurrencyPrefs = (prefs: CurrencyPrefs) => JSON.stringify(prefs);

/**
 * What was saved, or null for nothing usable: never saved, garbled, or none
 * of the currencies it names is one the app still offers. Null leaves the
 * person where everyone starts, with both.
 */
export function parseCurrencyPrefs(raw: string | null): CurrencyPrefs | null {
  if (!raw) return null;
  let saved: unknown;
  try {
    saved = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof saved !== 'object' || saved === null) return null;
  const { uses: savedUses, newGroups } = saved as { uses?: unknown; newGroups?: unknown };
  if (!Array.isArray(savedUses)) return null;
  const uses = SUPPORTED_CURRENCIES.filter((c) => savedUses.includes(c));
  if (uses.length === 0) return null;
  return { uses, newGroups: isSupportedCurrency(newGroups) && uses.includes(newGroups) ? newGroups : uses[0] };
}
