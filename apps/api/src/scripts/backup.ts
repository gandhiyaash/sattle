/**
 * Copies the database into data/backups/.
 *
 *   npm run db:backup -w @sattle/api                      # kind "manual"
 *   npm run db:backup -w @sattle/api -- deploy 1ec13de    # what the deploy job runs
 *   npm run db:backup -w @sattle/api -- daily             # what the daily timer runs
 *
 * DATABASE_PATH and BACKUP_DIR come from apps/api/.env like the server's.
 * A missing database isn't an error: a fresh server has nothing to copy yet.
 */

import { backupDb, type BackupKind } from '../backup';

const KEEP: Record<BackupKind, number> = { deploy: 20, daily: 14, manual: 10 };

const kind = (process.argv[2] ?? 'manual') as BackupKind;
if (!(kind in KEEP)) {
  console.error(`Unknown backup kind "${kind}". Use deploy, daily or manual.`);
  process.exit(1);
}

const dbPath = process.env.DATABASE_PATH ?? 'data/sattle.db';
const file = backupDb({
  dbPath,
  dir: process.env.BACKUP_DIR ?? 'data/backups',
  kind,
  note: process.argv[3],
  keep: KEEP[kind],
});
console.log(file ? `backup: ${file}` : `backup: no database at ${dbPath} yet, nothing to copy`);
