/**
 * AppData's copy, in files in the app's own storage: other apps can't read
 * them, and they go when the app is uninstalled. Read in one go when the app
 * starts, so the first screen is drawn from them.
 *
 * The copy of the server's answer is in the cache folder, which phones leave
 * out of iCloud and Android backups: it holds what people spent and their UPI
 * ID, and has no business on a backup server, nor on a restored phone that
 * doesn't have the account's token with it. A phone short of space may empty
 * that folder; the app then reads everything afresh, as on a first launch.
 *
 * The changes still to be sent can't be read afresh: until the server has
 * them, this file is the only place they are. So they're in the documents
 * folder, which the phone never empties. That folder is backed up, but the
 * file is small, holds only the changes still on their way, and a restored
 * phone without the token drops it (AppData's `owner`).
 *
 * Each is written to a file beside it and moved into place, so an app killed
 * in the middle of a write leaves the last copy whole rather than half of a
 * new one.
 */

import { Directory, File, Paths } from 'expo-file-system';

import type { SavedPart, SavedStore } from './AppData';

const PLACES: Record<SavedPart, { dir: () => Directory; name: string }> = {
  copy: { dir: () => Paths.cache, name: 'sattle-data.json' },
  changes: { dir: () => Paths.document, name: 'sattle-changes.json' },
};

const main = (part: SavedPart) => new File(PLACES[part].dir(), PLACES[part].name);
const next = (part: SavedPart) => new File(PLACES[part].dir(), `${PLACES[part].name}.next`);

export const savedStore: SavedStore = {
  read(part) {
    const saved = main(part);
    if (saved.exists) return saved.textSync();
    // Killed between the write and the move: the new copy is whole, only not yet in place.
    const written = next(part);
    return written.exists ? written.textSync() : null;
  },
  write(part, text) {
    const written = next(part);
    written.write(text);
    written.moveSync(main(part), { overwrite: true });
  },
  clear() {
    for (const part of Object.keys(PLACES) as SavedPart[]) {
      for (const file of [main(part), next(part)]) if (file.exists) file.delete();
    }
  },
};
