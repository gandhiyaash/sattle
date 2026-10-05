/**
 * The currency choice, live: read once at launch, and every screen that
 * depends on it redraws the moment it changes. See currencyPrefs.ts for what
 * it means.
 */

import { useMemo, useSyncExternalStore } from 'react';

import { payWays, type PayWays } from '@sattle/core';
import { EVERY_CURRENCY, parseCurrencyPrefs, serializeCurrencyPrefs, type CurrencyPrefs } from './currencyPrefs';
import { readCurrencies, writeCurrencies } from './currencyStore';

/** Undefined until the device has answered; null when they have never changed it. */
let choice: CurrencyPrefs | null | undefined;
const listeners = new Set<() => void>();

function apply(next: CurrencyPrefs | null) {
  choice = next;
  listeners.forEach((l) => l());
}

export function chooseCurrencies(next: CurrencyPrefs) {
  apply(next);
  // If it can't be kept, the choice still holds until the app is closed.
  void writeCurrencies(serializeCurrencyPrefs(next)).catch(() => {});
}

// A read that fails is treated as never having changed it: they use both.
readCurrencies()
  .then(parseCurrencyPrefs, () => null)
  // Unless they changed it in the meantime.
  .then((saved) => choice === undefined && apply(saved));

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether the device has said what they use. The app waits for it at launch,
 * so someone who turned a currency off isn't shown it for a moment first.
 */
export function useCurrenciesRead(): boolean {
  return useSyncExternalStore(subscribe, () => choice !== undefined);
}

/** What they use. Unless they have changed it, both. */
export function useCurrencyPrefs(): CurrencyPrefs {
  return useSyncExternalStore(subscribe, () => choice) ?? EVERY_CURRENCY;
}

/** Which ways to pay to show them: in one group, or with no `groupCurrency`, across the app. */
export function usePayWays(groupCurrency?: string): PayWays {
  const { uses } = useCurrencyPrefs();
  return useMemo(() => payWays(uses, groupCurrency), [uses, groupCurrency]);
}
