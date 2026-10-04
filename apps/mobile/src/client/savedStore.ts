/**
 * Where this device keeps what it saved of the account's groups. Web:
 * localStorage, like the account token. A browser that blocks it or has no
 * room left throws, and SavedReads carries on with nothing stored.
 *
 * Native uses savedStore.native.ts (a file in the app's own storage) instead;
 * Metro picks that file on iOS and Android.
 */

import type { SavedStore } from './SavedReads';

const KEY = 'sattle.saved';

export const savedStore: SavedStore = {
  read: () => globalThis.localStorage?.getItem(KEY) ?? null,
  write: (text) => globalThis.localStorage?.setItem(KEY, text),
  clear: () => globalThis.localStorage?.removeItem(KEY),
};
