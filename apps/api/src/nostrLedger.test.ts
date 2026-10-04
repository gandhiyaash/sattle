import { beforeEach, describe, expect, it } from 'vitest';

import { computeBalances, type LedgerBackup } from '@sattle/core';
import type { Event } from 'nostr-tools';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';

import { createApp } from './app';
import { openDb, seedIfEmpty, type Db } from './db';
import { LEDGER_KIND, NostrLedger, groupTag, parseBackupUri, readLedger, signEntry, type LedgerEntry } from './nostrLedger';
import type { NostrTransport } from './nwc';
import { SimulatedPayments } from './payments';
import { createRepo } from './repo';

function fakeRelay(opts: { down?: boolean } = {}) {
  const events: Event[] = [];
  const transport: NostrTransport & { down: boolean } = {
    down: opts.down ?? false,
    async publish(e) {
      if (transport.down) throw new Error('down');
      events.push(e);
    },
    subscribe: () => () => {},
    get: async () => null,
    close() {},
  };
  return { events, transport };
}

let db: Db;
let relay: ReturnType<typeof fakeRelay>;
let ledger: NostrLedger;

beforeEach(() => {
  db = openDb(':memory:');
  seedIfEmpty(db);
  relay = fakeRelay();
  ledger = new NostrLedger({ db, relays: ['wss://relay.test'], transport: relay.transport });
});

const access = (groupId: string) => parseBackupUri(ledger.backup(groupId).uri);

const addExpense = (groupId: string, id: string, amount: number) => {
  const repo = createRepo(db);
  const [a, b] = repo.members(groupId);
  repo.insertExpense({
    id, groupId, description: 'Chai', amount, paidByMemberId: a.id, splitMode: 'equal',
    parts: [{ memberId: a.id, amount: amount / 2 }, { memberId: b.id, amount: amount / 2 }],
    createdAt: new Date().toISOString(),
  });
};

describe('expenses that change after they were written down', () => {
  const read = async (groupId: string) => {
    await ledger.tick();
    return readLedger(relay.events, access(groupId));
  };
  const chai = (groupId: string) => createRepo(db).expense('e-chai')!;

  it('reads an edited expense as it now stands, without breaking the chain', async () => {
    addExpense('g-goa', 'e-chai', 200);
    const before = await read('g-goa');
    const repo = createRepo(db);
    repo.updateExpense({ ...chai('g-goa'), description: 'Chai and samosa', amount: 500, parts: chai('g-goa').parts.map((p) => ({ ...p, amount: 250 })) });

    const after = await read('g-goa');
    expect(after.problems).toEqual([]);
    expect(after.entries).toBe(before.entries + 1);
    expect(after.expenses.filter((e) => e.id === 'e-chai')).toMatchObject([{ description: 'Chai and samosa', amount: 500 }]);
    // Where it always was in the list: an edit doesn't move it to the end.
    expect(after.expenses.map((e) => e.id)).toEqual(before.expenses.map((e) => e.id));
    expect(computeBalances(repo.group('g-goa')!.memberIds, after.expenses, after.settlements)).toEqual(
      computeBalances(repo.group('g-goa')!.memberIds, repo.expenses('g-goa'), repo.settlements('g-goa'))
    );
  });

  it('drops a removed expense, and says so with an entry of its own', async () => {
    addExpense('g-goa', 'e-chai', 200);
    const before = await read('g-goa');
    const repo = createRepo(db);
    repo.deleteExpense(chai('g-goa'));

    const after = await read('g-goa');
    expect(after.problems).toEqual([]);
    expect(after.entries).toBe(before.entries + 1);
    expect(after.expenses.map((e) => e.id)).not.toContain('e-chai');
    expect(after.expenses).toHaveLength(repo.expenses('g-goa').length);
  });

  it('keeps several changes made in the same instant in the order they happened', async () => {
    addExpense('g-goa', 'e-chai', 200);
    const repo = createRepo(db);
    for (const amount of [300, 400, 500]) repo.updateExpense({ ...chai('g-goa'), amount });

    const after = await read('g-goa');
    expect(after.problems).toEqual([]);
    expect(after.expenses.find((e) => e.id === 'e-chai')?.amount).toBe(500);
  });

  it('copes with an expense removed before it was ever written down', async () => {
    await ledger.tick();
    addExpense('g-goa', 'e-chai', 200);
    const repo = createRepo(db);
    repo.deleteExpense(chai('g-goa'));

    const after = await read('g-goa');
    expect(after.problems).toEqual([]);
    expect(after.expenses.map((e) => e.id)).not.toContain('e-chai');
    expect(ledger.sync()).toBe(0);
  });
});

describe('sync', () => {
  it('signs one entry per expense and confirmed settlement, once', () => {
    const repo = createRepo(db);
    const expected =
      repo.expenses('g-goa').length +
      repo.settlements('g-goa').filter((s) => s.status === 'confirmed' || s.status === 'manually_confirmed').length;

    ledger.sync();
    expect(ledger.backup('g-goa').entries).toBe(expected);
    expect(ledger.sync()).toBe(0);
  });

  it('rebuilds the same balances from the relay alone', async () => {
    await ledger.tick();
    const repo = createRepo(db);
    for (const groupId of ['g-goa', 'g-flat']) {
      const read = readLedger(relay.events, access(groupId));
      expect(read.problems).toEqual([]);
      expect(read.group?.id).toBe(groupId);
      const memberIds = read.members.map((m) => m.id);
      expect(computeBalances(memberIds, read.expenses, read.settlements)).toEqual(
        computeBalances(repo.group(groupId)!.memberIds, repo.expenses(groupId), repo.settlements(groupId))
      );
    }
  });

  it('chains a new entry onto the last one', async () => {
    await ledger.tick();
    const before = ledger.backup('g-goa').entries;
    addExpense('g-goa', 'e-new', 400);
    await ledger.tick();

    const read = readLedger(relay.events, access('g-goa'));
    expect(read.entries).toBe(before + 1);
    expect(read.expenses.at(-1)?.id).toBe('e-new');
    expect(read.problems).toEqual([]);
  });

  it('keeps entries encrypted: no names or amounts on the relay', async () => {
    await ledger.tick();
    // Names are looked for outside the content only: the content is base64, where
    // "Goa" turns up by chance in about one run in fifty.
    const wire = JSON.stringify(relay.events.map(({ content: _, ...rest }) => rest));
    expect(wire).not.toContain('Goa');
    expect(wire).not.toContain('Aman');
    // And the content is ciphertext. A plaintext entry would be JSON, with braces and quotes.
    for (const e of relay.events) expect(e.content).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(relay.events.every((e) => e.kind === LEDGER_KIND)).toBe(true);
  });
});

describe('publish', () => {
  it('keeps entries while the relays are down and sends them once they are back', async () => {
    relay.transport.down = true;
    await ledger.tick();
    const { entries, published } = ledger.backup('g-goa');
    expect(entries).toBeGreaterThan(0);
    expect(published).toBe(0);

    relay.transport.down = false;
    await ledger.tick();
    expect(ledger.backup('g-goa').published).toBe(entries);
  });

  it('signs but sends nothing with no relays', async () => {
    const quiet = new NostrLedger({ db, relays: [], transport: relay.transport });
    await quiet.tick();
    expect(relay.events).toEqual([]);
    expect(quiet.backup('g-goa').entries).toBeGreaterThan(0);
  });

  it('keeps one signing key across restarts', () => {
    const again = new NostrLedger({ db, relays: [] });
    expect(again.pubkey).toBe(ledger.pubkey);
    expect(again.groupKey('g-goa')).toBe(ledger.groupKey('g-goa'));
  });
});

describe('readLedger', () => {
  const entry = (seq: number, prev: string | null): LedgerEntry => ({
    v: 1, seq, prev, group: { id: 'g', name: 'G', currency: 'INR' }, members: [],
  });
  const key = 'ab'.repeat(32);
  const server = generateSecretKey();
  const at = 1_700_000_000;

  it('reports a missing entry and a broken chain', () => {
    const e1 = signEntry(entry(1, null), key, server, at);
    const e3 = signEntry(entry(3, 'f'.repeat(64)), key, server, at);
    const read = readLedger([e1, e3], { pubkey: e1.pubkey, key });
    expect(read.problems).toEqual(['Entry 2 is missing.']);

    const e2 = signEntry(entry(2, 'f'.repeat(64)), key, server, at);
    expect(readLedger([e1, e2], { pubkey: e1.pubkey, key }).problems).toEqual([
      'Entry 2 doesn’t follow the entry before it.',
    ]);
  });

  it('ignores entries signed by anyone but the server', () => {
    const real = signEntry(entry(1, null), key, server, at);
    const forged = signEntry(entry(2, real.id), key, generateSecretKey(), at);
    expect(readLedger([real, forged], { pubkey: real.pubkey, key }).entries).toBe(1);
  });

  it('skips an entry whose signature was tampered with', () => {
    const real = signEntry(entry(1, null), key, server, at);
    // Through JSON, like an event off a relay: nostr-tools caches a passed check on the object.
    const tampered = JSON.parse(JSON.stringify({ ...real, created_at: real.created_at + 1 }));
    const read = readLedger([tampered], { pubkey: real.pubkey, key });
    expect(read.entries).toBe(0);
    expect(read.problems[0]).toMatch(/bad signature/);
  });

  it('reads nothing with the wrong key', () => {
    const ev = finalizeEvent(
      { kind: LEDGER_KIND, created_at: at, tags: [['h', groupTag(key)]], content: 'not ciphertext' },
      server
    );
    expect(readLedger([ev], { pubkey: ev.pubkey, key: 'cd'.repeat(32) }).entries).toBe(0);
    expect(readLedger([ev], { pubkey: ev.pubkey, key }).problems[0]).toMatch(/doesn’t decrypt/);
  });
});

describe('GET /groups/:id/ledger', () => {
  const app = () =>
    createApp({
      db,
      ledger,
      demoUserId: 'u-yash',
      payments: (repo) =>
        new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
    });

  it('gives a member the backup key', async () => {
    const res = await app().request('/groups/g-goa/ledger');
    expect(res.status).toBe(200);
    const body = (await res.json()) as LedgerBackup;
    expect(parseBackupUri(body.uri)).toEqual({ pubkey: ledger.pubkey, key: ledger.groupKey('g-goa'), relays: ['wss://relay.test'] });
    expect(body.npub).toMatch(/^npub1/);
  });

  it('is a 404 for anyone outside the group', async () => {
    db.prepare("INSERT INTO expense_groups (id, name, currency, created_at) VALUES ('g-secret', 'x', 'INR', '2026-01-01')").run();
    expect((await app().request('/groups/g-secret/ledger')).status).toBe(404);
  });
});
