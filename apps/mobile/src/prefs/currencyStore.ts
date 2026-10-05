/**
 * Where this device keeps which currencies its owner uses. Web: localStorage,
 * guarded the same way as the account token; losing it means the first-launch
 * tour asks again.
 *
 * Native uses currencyStore.native.ts instead; Metro picks that file on iOS
 * and Android.
 */

const KEY = 'sattle.currencies';

export async function readCurrencies(): Promise<string | null> {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export async function writeCurrencies(value: string): Promise<void> {
  try {
    globalThis.localStorage?.setItem(KEY, value);
  } catch {
    // Storage blocked: the choice lasts until the tab closes.
  }
}
