/**
 * Where AppData keeps its copy between launches. Web: localStorage, beside
 * the account token, one key for each part. A browser that blocks it or has
 * no room left throws, and AppData carries on with nothing kept.
 *
 * Native uses savedStore.native.ts (files in the app's own storage) instead;
 * Metro picks that file on iOS and Android.
 */

import type { SavedPart, SavedStore } from './AppData';

const KEYS: Record<SavedPart, string> = { copy: 'sattle.data', changes: 'sattle.changes' };

export const savedStore: SavedStore = {
  read: (part) => globalThis.localStorage?.getItem(KEYS[part]) ?? null,
  write: (part, text) => globalThis.localStorage?.setItem(KEYS[part], text),
  clear: () => {
    for (const key of Object.values(KEYS)) globalThis.localStorage?.removeItem(key);
  },
};
