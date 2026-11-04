/**
 * AppData's copy, in a file in the app's own storage: other apps can't read
 * it, and it goes when the app is uninstalled. Read in one go when the app
 * starts, so the first screen is drawn from it.
 *
 * In the cache folder, which phones leave out of iCloud and Android backups:
 * the copy holds what people spent and their UPI ID, and has no business on
 * a backup server, nor on a restored phone that doesn't have the account's
 * token with it. A phone short of space may empty that folder; the app then
 * reads everything afresh, as on a first launch.
 *
 * Written to a file beside it and moved into place, so an app killed in the
 * middle of a write leaves the last copy whole rather than half of a new one.
 */

import { File, Paths } from 'expo-file-system';

import type { SavedStore } from './AppData';

const main = () => new File(Paths.cache, 'sattle-data.json');
const next = () => new File(Paths.cache, 'sattle-data.json.next');

export const savedStore: SavedStore = {
  read() {
    const saved = main();
    if (saved.exists) return saved.textSync();
    // Killed between the write and the move: the new copy is whole, only not yet in place.
    const written = next();
    return written.exists ? written.textSync() : null;
  },
  write(text) {
    const written = next();
    written.write(text);
    written.moveSync(main(), { overwrite: true });
  },
  clear() {
    for (const file of [main(), next()]) if (file.exists) file.delete();
  },
};
