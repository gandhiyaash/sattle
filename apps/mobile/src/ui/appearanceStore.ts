/**
 * Where this device keeps its light/dark choice. Web: localStorage, guarded
 * the same way as the account token; losing it just means following the
 * system again.
 *
 * Native uses appearanceStore.native.ts instead; Metro picks that file on
 * iOS and Android.
 */

const KEY = 'sattle.appearance';

export async function readAppearance(): Promise<string | null> {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export async function writeAppearance(value: string): Promise<void> {
  try {
    globalThis.localStorage?.setItem(KEY, value);
  } catch {
    // Storage blocked: the choice lasts until the tab closes.
  }
}
