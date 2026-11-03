/**
 * Where AppData keeps its copy between launches. Web: localStorage, beside
 * the account token. A browser that blocks it or has no room left throws, and
 * AppData carries on with nothing kept.
 *
 * Native uses savedStore.native.ts (a file in the app's own storage) instead;
 * Metro picks that file on iOS and Android.
 */

import type { SavedStore } from './AppData';

const KEY = 'sattle.data';

export const savedStore: SavedStore = {
  read: () => globalThis.localStorage?.getItem(KEY) ?? null,
  write: (text) => globalThis.localStorage?.setItem(KEY, text),
  clear: () => globalThis.localStorage?.removeItem(KEY),
};
