/**
 * Which currencies someone uses. The first screen asks, with rupees ticked
 * (RUPEES_ONLY), and Account changes it later. Someone new who joins from a
 * group's link isn't asked: they start on that group's currency (onlyIn). A
 * device that has never said, like one signed in before the question
 * existed, uses both.
 *
 * It decides three things. A new group starts in `newGroups`. The app only
 * shows the ways to pay that go with what they use: UPI with rupees,
 * Lightning with bitcoin (payWays in @sattle/core). And Nostr goes with
 * bitcoin (showsNostr): without it, nothing of Nostr is shown either.
 *
 * It is kept on this device and the server never sees it. It changes what
 * the app shows, not what anyone is allowed to do.
 *
 * Nothing here imports React Native, so it runs under vitest.
 */

import { BITCOIN, SUPPORTED_CURRENCIES, isSupportedCurrency, type SupportedCurrency } from '@sattle/core';

export interface CurrencyPrefs {
  /** In the order the app lists them. Never empty. */
  uses: SupportedCurrency[];
  /** What a new group is kept in. One of `uses`. */
  newGroups: SupportedCurrency;
}

/** A device that has never said: nothing is hidden, and a new group opens in rupees. */
export const EVERY_CURRENCY: CurrencyPrefs = { uses: [...SUPPORTED_CURRENCIES], newGroups: SUPPORTED_CURRENCIES[0] };

/** What the first screen starts with ticked. Bitcoin is a tap away. */
export const RUPEES_ONLY: CurrencyPrefs = { uses: ['INR'], newGroups: 'INR' };

/**
 * One currency alone: what someone new starts on after joining a group kept
 * in it. Null for a currency the app doesn't offer, which leaves them as
 * they are.
 */
export function onlyIn(currency: string): CurrencyPrefs | null {
  return isSupportedCurrency(currency) ? { uses: [currency], newGroups: currency } : null;
}

/**
 * Whether to show anything of Nostr: signing in with a Nostr key, linking
 * one, a group's backup on relays and reading it back. It goes with bitcoin,
 * so someone who only uses rupees never meets it. The backup itself goes on
 * either way, on the server.
 */
export const showsNostr = (prefs: CurrencyPrefs): boolean => prefs.uses.includes(BITCOIN);

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
