/**
 * The currency choice, live: read once at launch, and every screen that
 * depends on it redraws the moment it changes. See currencyPrefs.ts for what
 * it means.
 */

import { useMemo, useSyncExternalStore } from 'react';

import { payWays, type PayWays } from '@sattle/core';
import { EVERY_CURRENCY, parseCurrencyPrefs, serializeCurrencyPrefs, type CurrencyPrefs } from './currencyPrefs';
import { readCurrencies, writeCurrencies } from './currencyStore';

/** Undefined until the device has answered; null when they have never chosen. */
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

// A read that fails is treated as never having chosen: the tour asks again.
readCurrencies()
  .then(parseCurrencyPrefs, () => null)
  // Unless they answered in the meantime.
  .then((saved) => choice === undefined && apply(saved));

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For the gate at launch: undefined while reading, null when the tour hasn't been finished. */
export function useCurrencyChoice(): CurrencyPrefs | null | undefined {
  return useSyncExternalStore(subscribe, () => choice);
}

/** What they use. Before they've chosen, everything. */
export function useCurrencyPrefs(): CurrencyPrefs {
  return useCurrencyChoice() ?? EVERY_CURRENCY;
}

/** Which ways to pay to show them: in one group, or with no `groupCurrency`, across the app. */
export function usePayWays(groupCurrency?: string): PayWays {
  const { uses } = useCurrencyPrefs();
  return useMemo(() => payWays(uses, groupCurrency), [uses, groupCurrency]);
}
