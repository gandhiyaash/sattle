/**
 * Copies of the SQLite database, taken with VACUUM INTO: a consistent
 * snapshot even while the server is writing, without stopping it and
 * without running migrations (this never goes through openDb).
 *
 * Files are named sattle-<time>-<kind>[-<note>].db, so they sort by time.
 * Each kind is pruned on its own, so a busy day of deploys can't push out
 * the daily copies.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type BackupKind = 'deploy' | 'daily' | 'manual';

export interface BackupOptions {
  dbPath: string;
  dir: string;
  kind: BackupKind;
  /** Free text for the file name, like the commit being deployed. */
  note?: string;
  /** How many of this kind to keep, newest first. */
  keep: number;
  now?: Date;
}

/** Returns the new file, or null when there's no database yet to copy. */
export function backupDb({ dbPath, dir, kind, note, keep, now = new Date() }: BackupOptions): string | null {
  if (!existsSync(dbPath)) return null;
  mkdirSync(dir, { recursive: true });

  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const safeNote = note?.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  const file = join(dir, `sattle-${stamp}-${kind}${safeNote ? `-${safeNote}` : ''}.db`);
  if (existsSync(file)) rmSync(file);

  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('VACUUM INTO ?').run(file);
  } finally {
    db.close();
  }

  prune(dir, kind, keep);
  return file;
}

/** This kind's backups in `dir`, newest first. */
export function listBackups(dir: string, kind: BackupKind): string[] {
  if (!existsSync(dir)) return [];
  const pattern = new RegExp(`^sattle-\\d{8}T\\d{6}Z-${kind}(-.*)?\\.db$`);
  return readdirSync(dir)
    .filter((f) => pattern.test(f))
    .sort()
    .reverse();
}

function prune(dir: string, kind: BackupKind, keep: number) {
  for (const old of listBackups(dir, kind).slice(Math.max(1, keep))) rmSync(join(dir, old));
}
