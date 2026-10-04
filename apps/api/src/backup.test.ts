import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { backupDb, listBackups } from './backup';
import { openDb, seedIfEmpty } from './db';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'sattle-backup-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const at = (i: number) => new Date(Date.UTC(2026, 9, 4, 0, 0, i));
const count = (path: string, table: string) =>
  (new DatabaseSync(path).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('backupDb', () => {
  it('copies the database, including writes still in the WAL, while it stays open', () => {
    const root = tmp();
    const dbPath = join(root, 'sattle.db');
    const live = openDb(dbPath);
    seedIfEmpty(live);
    live.prepare("INSERT INTO users (id, display_name, token) VALUES ('u-new', 'New', 't-new')").run();

    const file = backupDb({ dbPath, dir: join(root, 'backups'), kind: 'deploy', note: '1ec13de', keep: 5, now: at(0) })!;
    expect(file).toMatch(/sattle-20261004T000000Z-deploy-1ec13de\.db$/);
    expect(count(file, 'users')).toBe(count(dbPath, 'users'));
    expect(count(file, 'expenses')).toBeGreaterThan(0);
    // The live database is untouched and still writable.
    live.prepare("INSERT INTO users (id, display_name, token) VALUES ('u-after', 'After', 't-after')").run();
    expect(count(file, 'users')).toBe(count(dbPath, 'users') - 1);
  });

  it('returns null when there is no database yet', () => {
    const root = tmp();
    expect(backupDb({ dbPath: join(root, 'none.db'), dir: join(root, 'b'), kind: 'daily', keep: 3 })).toBeNull();
    expect(listBackups(join(root, 'b'), 'daily')).toEqual([]);
  });

  it('keeps the newest `keep` of each kind, and prunes kinds separately', () => {
    const root = tmp();
    const dbPath = join(root, 'sattle.db');
    openDb(dbPath).close();
    const dir = join(root, 'backups');

    for (let i = 0; i < 4; i++) backupDb({ dbPath, dir, kind: 'daily', keep: 2, now: at(i) });
    for (let i = 10; i < 15; i++) backupDb({ dbPath, dir, kind: 'deploy', keep: 3, now: at(i) });

    expect(listBackups(dir, 'daily')).toEqual(['sattle-20261004T000003Z-daily.db', 'sattle-20261004T000002Z-daily.db']);
    expect(listBackups(dir, 'deploy')).toHaveLength(3);
    expect(listBackups(dir, 'deploy')[0]).toBe('sattle-20261004T000014Z-deploy.db');
    expect(readdirSync(dir)).toHaveLength(5);
  });

  it('keeps file names safe whatever the note is', () => {
    const root = tmp();
    const dbPath = join(root, 'sattle.db');
    openDb(dbPath).close();
    const file = backupDb({ dbPath, dir: root, kind: 'manual', note: '../../etc x;rm', keep: 1, now: at(0) })!;
    expect(file).toBe(join(root, 'sattle-20261004T000000Z-manual-....etcxrm.db'));
  });
});
