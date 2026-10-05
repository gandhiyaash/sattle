/**
 * Which currencies someone uses. They pick at the end of the first-launch
 * tour (OnboardingScreen) and can change it under Account.
 *
 * It decides two things. A new group starts in `newGroups`. And the app only
 * shows the ways to pay that go with what they use: UPI with rupees,
 * Lightning with bitcoin (payWays in @sattle/core). Someone who has never
 * heard of bitcoin picks rupees and never meets it; someone who only uses
 * bitcoin never meets UPI.
 *
 * It is kept on this device and the server never sees it. It changes what
 * the app shows, not what anyone is allowed to do.
 *
 * Nothing here imports React Native, so it runs under vitest.
 */

import { SUPPORTED_CURRENCIES, isSupportedCurrency, type SupportedCurrency } from '@sattle/core';

export interface CurrencyPrefs {
  /** In the order the app lists them. Empty only while someone is still choosing. */
  uses: SupportedCurrency[];
  /** What a new group is kept in. One of `uses`, whenever there are any. */
  newGroups: SupportedCurrency;
}

/** Before anyone has chosen: nothing is hidden, and a new group is in rupees. */
export const EVERY_CURRENCY: CurrencyPrefs = { uses: [...SUPPORTED_CURRENCIES], newGroups: SUPPORTED_CURRENCIES[0] };

/** Where the tour's last step starts: the choice is theirs to make, so nothing is ticked. */
export const NO_CURRENCY_YET: CurrencyPrefs = { uses: [], newGroups: SUPPORTED_CURRENCIES[0] };

/** Whether there is a choice to save: at least one currency. */
export const isChosen = (prefs: CurrencyPrefs) => prefs.uses.length > 0;

/**
 * Turns one currency on or off. What new groups start in follows along: it
 * stays put while it is still one they use, and otherwise becomes one that is.
 */
export function toggleCurrency(prefs: CurrencyPrefs, currency: SupportedCurrency): CurrencyPrefs {
  const on = !prefs.uses.includes(currency);
  const uses = SUPPORTED_CURRENCIES.filter((c) => (c === currency ? on : prefs.uses.includes(c)));
  return { uses, newGroups: uses.includes(prefs.newGroups) ? prefs.newGroups : (uses[0] ?? prefs.newGroups) };
}

/** Sets what new groups start in. Ignored for a currency they don't use. */
export function startNewGroupsIn(prefs: CurrencyPrefs, currency: SupportedCurrency): CurrencyPrefs {
  return prefs.uses.includes(currency) ? { ...prefs, newGroups: currency } : prefs;
}

export const serializeCurrencyPrefs = (prefs: CurrencyPrefs) => JSON.stringify(prefs);

/**
 * What was saved, or null for nothing usable: never saved, garbled, or none
 * of the currencies it names is one the app still offers. Null sends the
 * person back through the tour, which is where the question is asked.
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
