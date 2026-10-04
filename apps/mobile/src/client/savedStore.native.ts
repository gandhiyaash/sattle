/**
 * What was saved of the account's groups, in a file in the app's own storage:
 * other apps can't read it, and it goes when the app is uninstalled.
 */

import { File, Paths } from 'expo-file-system';

import type { SavedStore } from './SavedReads';

const file = () => new File(Paths.document, 'saved.json');

export const savedStore: SavedStore = {
  read() {
    const saved = file();
    return saved.exists ? saved.textSync() : null;
  },
  write: (text) => file().write(text),
  clear() {
    const saved = file();
    if (saved.exists) saved.delete();
  },
};
