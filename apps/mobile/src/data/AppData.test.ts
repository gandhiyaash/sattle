import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SattleError, type Expense, type ExpenseInput, type Group, type GroupSnapshot, type Member, type SyncAnswer, type SyncView } from '@sattle/core';

import type { SattleClient } from '../client/SattleClient';
import { AppData, tokenFingerprint, type SavedStore } from './AppData';
import { isLocalId, marksFor, unsavedIn } from './changes';
import { groupViewOf } from './views';

// -- a server the test answers by hand -------------------------------------------

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function fakeClient() {
  const syncs: Array<Pending<SyncAnswer> & { version?: string; groups?: readonly string[] }> = [];
  const writes: Array<Pending<unknown> & { kind: 'add' | 'edit' | 'delete'; key?: string; args: unknown[] }> = [];
  const client = {
    sync: (version?: string, groups?: readonly string[]) =>
      new Promise<SyncAnswer>((resolve, reject) => syncs.push({ version, groups, resolve, reject })),
    addExpense: (input: ExpenseInput, key?: string) =>
      new Promise((resolve, reject) => writes.push({ kind: 'add', key, args: [input], resolve, reject })),
    updateExpense: (id: string, input: ExpenseInput, key?: string) =>
      new Promise((resolve, reject) => writes.push({ kind: 'edit', key, args: [id, input], resolve, reject })),
    deleteExpense: (groupId: string, id: string, key?: string) =>
      new Promise((resolve, reject) => writes.push({ kind: 'delete', key, args: [groupId, id], resolve, reject })),
  } as unknown as SattleClient;
  return { client, syncs, writes };
}

/** Lets every promise chain that can move, move. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function memoryStore(text: string | null = null): SavedStore & { text: string | null; writes: number } {
  const store = {
    text,
    writes: 0,
    read: () => store.text,
    write: (t: string) => {
      store.text = t;
      store.writes++;
    },
    clear: () => {
      store.text = null;
    },
  };
  return store;
}

// -- a small world: Riya, in two groups ------------------------------------------

const riya = { id: 'u-riya', displayName: 'Riya' };
const member = (id: string, groupId: string, displayName: string, userId?: string): Member => ({
  id,
  groupId,
  displayName,
  status: userId ? 'joined' : 'ghost',
  ...(userId ? { claimedByUserId: userId } : {}),
});
const group = (id: string, name: string, memberIds: string[]): Group => ({
  id,
  name,
  currency: 'INR',
  memberIds,
  approveJoins: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  simplifyDebts: false,
});
const expense = (id: string, groupId: string, amount: number, by: string, between: string[], description = id): Expense => ({
  id,
  groupId,
  description,
  amount,
  paidByMemberId: by,
  splitMode: 'equal',
  parts: between.map((memberId, i) => ({
    memberId,
    amount: Math.floor(amount / between.length) + (i < amount % between.length ? 1 : 0),
  })),
  createdAt: '2026-11-02T10:00:00.000Z',
});

function goa(expenses: Expense[] = []): GroupSnapshot {
  return {
    group: group('g-goa', 'Goa', ['m-riya', 'm-om']),
    members: [member('m-riya', 'g-goa', 'Riya', riya.id), member('m-om', 'g-goa', 'Om')],
    expenses,
    settlements: [],
    upiClaims: [],
    pendingJoins: [],
  };
}
function flat(expenses: Expense[] = []): GroupSnapshot {
  return {
    group: group('g-flat', 'Flat', ['m-riya2', 'm-yash']),
    members: [member('m-riya2', 'g-flat', 'Riya', riya.id), member('m-yash', 'g-flat', 'Yash')],
    expenses,
    settlements: [],
    upiClaims: [],
    pendingJoins: [],
  };
}
const world = (groups: GroupSnapshot[] = [goa(), flat()]): SyncView => ({
  user: riya,
  groups,
  joinRequests: [],
  upiProfile: { upiId: null, onGroupLinks: true },
});
/** What the server answers: the view, and a version that changes with it. */
const answer = (view: SyncView): SyncAnswer => ({ version: `v${JSON.stringify(view).length}-${view.groups.map((g) => g.expenses.length).join('.')}`, ...view });

const dinner: ExpenseInput = {
  groupId: 'g-goa',
  description: 'Dinner',
  amount: 900,
  paidByMemberId: 'm-riya',
  splitMode: 'equal',
  parts: [{ memberId: 'm-riya' }, { memberId: 'm-om' }],
};

/** An AppData that has had its first sync answered with `view`. */
async function synced(view: SyncView = world(), opts: ConstructorParameters<typeof AppData>[1] = {}) {
  const server = fakeClient();
  const data = new AppData(server.client, opts);
  const first = data.sync();
  server.syncs[0]!.resolve(answer(view));
  await first;
  return { data, ...server };
}

const expensesOf = (data: AppData, groupId = 'g-goa') =>
  data.getView()!.groups.find((g) => g.group.id === groupId)!.expenses;

let disposers: AppData[] = [];
const track = (data: AppData) => (disposers.push(data), data);
afterEach(() => {
  for (const d of disposers) d.dispose();
  disposers = [];
  vi.useRealTimers();
});

// -- syncing ------------------------------------------------------------------------

describe('syncing', () => {
  it('shows nothing before the first answer, then what the server said', async () => {
    const { client, syncs } = fakeClient();
    const data = track(new AppData(client));
    expect(data.getView()).toBeNull();
    const done = data.sync();
    expect(data.getStatus().syncing).toBe(true);
    syncs[0]!.resolve(answer(world()));
    await done;
    expect(data.getView()!.groups.map((g) => g.group.name)).toEqual(['Goa', 'Flat']);
    expect(data.getStatus()).toMatchObject({ syncing: false, error: null });
    expect(data.getStatus().syncedAt).not.toBeNull();
  });

  it('asks with the version it has, and keeps the very same view when nothing changed', async () => {
    const t = await synced();
    track(t.data);
    const before = t.data.getView();
    const again = t.data.sync();
    expect(t.syncs[1]!.version).toBe(answer(world()).version);
    t.syncs[1]!.resolve({ version: t.syncs[1]!.version!, unchanged: true });
    await again;
    expect(t.data.getView()).toBe(before);
  });

  it('keeps each group that didn’t change as the object it was, so what shows it isn’t drawn again', async () => {
    const t = await synced();
    track(t.data);
    const [goaBefore, flatBefore] = t.data.getView()!.groups;
    const again = t.data.sync();
    t.syncs[1]!.resolve(answer(world([goa(), flat([expense('e-rent', 'g-flat', 1000, 'm-yash', ['m-riya2', 'm-yash'])])])));
    await again;
    const [goaAfter, flatAfter] = t.data.getView()!.groups;
    expect(goaAfter).toBe(goaBefore);
    expect(flatAfter).not.toBe(flatBefore);
    expect(flatAfter!.expenses).toHaveLength(1);
  });

  it('asked again while one is on its way, runs one more after it, for everything asked since', async () => {
    const t = await synced();
    track(t.data);
    const a = t.data.sync(['g-goa']);
    const b = t.data.sync(['g-flat']);
    const c = t.data.sync(['g-goa']);
    expect(t.syncs).toHaveLength(2);
    t.syncs[1]!.resolve({ version: 'x', unchanged: true });
    await a;
    await settle();
    expect(t.syncs).toHaveLength(3);
    expect([...t.syncs[2]!.groups!].sort()).toEqual(['g-flat', 'g-goa']);
    t.syncs[2]!.resolve({ version: 'y', unchanged: true });
    await Promise.all([b, c]);
  });

  it('for some groups only, changes those and leaves the rest as they were', async () => {
    const t = await synced();
    track(t.data);
    const flatBefore = t.data.getView()!.groups[1];
    const scoped = t.data.sync(['g-goa']);
    expect(t.syncs[1]!.groups).toEqual(['g-goa']);
    // Answered for Goa alone, with a new spend in it.
    const goaNow = goa([expense('e-1', 'g-goa', 500, 'm-om', ['m-riya', 'm-om'])]);
    t.syncs[1]!.resolve(answer({ ...world([goaNow]) }));
    await scoped;
    const groups = t.data.getView()!.groups;
    expect(groups.map((g) => g.group.id)).toEqual(['g-goa', 'g-flat']);
    expect(groups[0]!.expenses.map((e) => e.id)).toEqual(['e-1']);
    expect(groups[1]).toBe(flatBefore);
  });

  it('drops a group asked for that the answer left out: the user isn’t in it any more', async () => {
    const t = await synced();
    track(t.data);
    const scoped = t.data.sync(['g-goa']);
    t.syncs[1]!.resolve(answer(world([])));
    await scoped;
    expect(t.data.getView()!.groups.map((g) => g.group.id)).toEqual(['g-flat']);
  });

  it('keeps what it has when a sync fails, and says why', async () => {
    const t = await synced();
    track(t.data);
    const before = t.data.getView();
    const again = t.data.sync();
    t.syncs[1]!.reject(new SattleError('network', 'Couldn’t reach the server.'));
    await again;
    expect(t.data.getView()).toBe(before);
    expect(t.data.getStatus().error?.code).toBe('network');
  });

  it('stops, and says so once, when the server doesn’t know the token at the first sync', async () => {
    const onSignedOut = vi.fn();
    const { client, syncs } = fakeClient();
    const data = new AppData(client, { onSignedOut });
    const first = data.sync();
    syncs[0]!.reject(new SattleError('unauthorized', 'Sign in again.'));
    expect(await first).toBe(false);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(await data.sync()).toBe(false);
    expect(syncs).toHaveLength(1);
  });

  it('turned away after a sync has worked, says so, and doesn’t sign the device out: the next launch checks', async () => {
    const onSignedOut = vi.fn();
    const t = await synced(world(), { onSignedOut });
    track(t.data);
    const again = t.data.sync();
    t.syncs[1]!.reject(new SattleError('unauthorized', 'Sign in again.'));
    await again;
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(t.data.getStatus().error?.code).toBe('unauthorized');
    expect(t.data.getView()).not.toBeNull();
  });

  it('isn’t signed out by a refusal while its key is being replaced', async () => {
    const onSignedOut = vi.fn();
    const { client, syncs } = fakeClient();
    const data = track(new AppData(client, { onSignedOut }));
    const release = data.holdSignOut();
    const first = data.sync();
    syncs[0]!.reject(new SattleError('unauthorized', 'This sign-in key was replaced.'));
    await first;
    release();
    expect(onSignedOut).not.toHaveBeenCalled();
  });
});

// -- keeping current ----------------------------------------------------------------

describe('keeping current', () => {
  beforeEach(() => vi.useFakeTimers());

  it('checks every few seconds while a screen asks, only while the app is in front', async () => {
    const t = await synced();
    track(t.data);
    const stop = t.data.keepCurrent(4000, 'g-goa');
    await vi.advanceTimersByTimeAsync(3999);
    expect(t.syncs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.syncs).toHaveLength(2);
    // For the one group the screen shows.
    expect(t.syncs[1]!.groups).toEqual(['g-goa']);
    t.syncs[1]!.resolve({ version: 'v', unchanged: true });
    await vi.advanceTimersByTimeAsync(0);

    t.data.setActive(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.syncs).toHaveLength(2);
    // Back in front: at once, then on the beat again.
    t.data.setActive(true);
    expect(t.syncs).toHaveLength(3);
    t.syncs[2]!.resolve({ version: 'v', unchanged: true });
    await vi.advanceTimersByTimeAsync(4000);
    expect(t.syncs).toHaveLength(4);
    stop();
    t.syncs[3]!.resolve({ version: 'v', unchanged: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.syncs).toHaveLength(4);
  });

  it('waits longer after each failure, up to half a minute', async () => {
    const t = await synced();
    track(t.data);
    t.data.keepCurrent(4000);
    const at: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = t.syncs.length;
      const started = Date.now();
      while (t.syncs.length === before) await vi.advanceTimersByTimeAsync(500);
      at.push(Date.now() - started);
      t.syncs[t.syncs.length - 1]!.reject(new SattleError('network', 'offline'));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(at).toEqual([4000, 8000, 16000, 30000, 30000, 30000]);
  });
});

// -- the user's own changes -----------------------------------------------------------

describe('an added expense', () => {
  it('shows at once, counted in the balances, before the server has answered', async () => {
    const t = await synced();
    track(t.data);
    const id = t.data.addExpense(dinner);
    expect(isLocalId(id)).toBe(true);
    const shown = expensesOf(t.data);
    expect(shown.map((e) => e.description)).toEqual(['Dinner']);
    expect(shown[0]!.parts).toEqual([
      { memberId: 'm-riya', amount: 450 },
      { memberId: 'm-om', amount: 450 },
    ]);
    expect(groupViewOf(t.data.getView()!, 'g-goa')!.myNet).toBe(450);
    expect(marksFor('g-goa', t.data.getChanges()).get(id)).toEqual({ state: 'sending' });
    expect(t.writes[0]).toMatchObject({ kind: 'add', args: [dinner] });
  });

  it('is never shown twice, whichever answer comes first', async () => {
    const t = await synced();
    track(t.data);
    t.data.addExpense(dinner);
    const real = expense('e-dinner', 'g-goa', 900, 'm-riya', ['m-riya', 'm-om'], 'Dinner');

    // A sync that already has it, under its real id, while the add is still on its way: not used.
    const early = t.data.sync();
    t.syncs[1]!.resolve(answer(world([goa([real]), flat()])));
    await early;
    expect(expensesOf(t.data).map((e) => e.description)).toEqual(['Dinner']);

    // The add's own answer: the real one takes the draft's place.
    t.writes[0]!.resolve(real);
    await settle();
    expect(expensesOf(t.data).map((e) => e.id)).toEqual(['e-dinner']);
    expect(marksFor('g-goa', t.data.getChanges()).size).toBe(0);

    // The sync that answer started has it too, and the change goes.
    expect(t.syncs).toHaveLength(3);
    t.syncs[2]!.resolve(answer(world([goa([real]), flat()])));
    await settle();
    expect(expensesOf(t.data).map((e) => e.id)).toEqual(['e-dinner']);
    expect(t.data.getChanges()).toEqual([]);
  });

  it('stays through a sync that left before the server had it', async () => {
    const t = await synced();
    track(t.data);
    t.data.addExpense(dinner);
    const real = expense('e-dinner', 'g-goa', 900, 'm-riya', ['m-riya', 'm-om'], 'Dinner');
    const slow = t.data.sync(['g-flat']);
    t.writes[0]!.resolve(real);
    await settle();
    // Answered after the add was, but asked before: it can't know of it, and doesn't take it away.
    t.syncs[1]!.resolve(answer(world([flat()])));
    await slow;
    expect(expensesOf(t.data).map((e) => e.id)).toEqual(['e-dinner']);
    expect(t.data.getChanges()).toHaveLength(1);
  });

  it('that the server refused shows as not saved, counts in nothing, and can be tried again or let go', async () => {
    const t = await synced();
    track(t.data);
    const id = t.data.addExpense(dinner);
    t.writes[0]!.reject(new SattleError('invalid_expense', 'Someone in that split isn’t in this group.'));
    await settle();
    expect(expensesOf(t.data)).toEqual([]);
    const g = t.data.getView()!.groups[0]!;
    const unsaved = unsavedIn(t.data.getChanges(), g, riya.id);
    expect(unsaved.map((u) => [u.expense.description, u.reason])).toEqual([['Dinner', 'Someone in that split isn’t in this group.']]);
    expect(groupViewOf(t.data.getView()!, 'g-goa')!.myNet).toBe(0);

    const firstKey = t.writes[0]!.key;
    t.data.retry(id);
    expect(t.writes[1]).toMatchObject({ kind: 'add', key: firstKey });
    t.writes[1]!.reject(new SattleError('invalid_expense', 'Still no.'));
    await settle();
    t.data.discard(id);
    expect(t.data.getChanges()).toEqual([]);
  });

  it('that couldn’t get there goes again with the same key once a sync works', async () => {
    const t = await synced();
    track(t.data);
    t.data.addExpense(dinner);
    t.writes[0]!.reject(new SattleError('network', 'offline'));
    await settle();
    expect(t.data.getChanges()[0]).toMatchObject({ state: 'failed', error: { retry: true } });
    // Not until the backoff is over.
    const soon = t.data.sync();
    t.syncs[1]!.resolve({ version: 'v', unchanged: true });
    await soon;
    expect(t.writes).toHaveLength(1);

    vi.useFakeTimers({ now: Date.now() + 3000 });
    const later = t.data.sync();
    t.syncs[2]!.resolve({ version: 'v', unchanged: true });
    await vi.advanceTimersByTimeAsync(0);
    await later;
    expect(t.writes).toHaveLength(2);
    expect(t.writes[1]!.key).toBe(t.writes[0]!.key);
  });
});

describe('a changed or deleted expense', () => {
  const lunch = expense('e-lunch', 'g-goa', 600, 'm-riya', ['m-riya', 'm-om'], 'Lunch');

  it('a change shows at once over the server’s, and one it refused is taken back and said', async () => {
    const t = await synced(world([goa([lunch]), flat()]));
    track(t.data);
    t.data.editExpense('e-lunch', { ...dinner, description: 'Brunch', amount: 800 });
    expect(expensesOf(t.data).map((e) => [e.id, e.description, e.amount])).toEqual([['e-lunch', 'Brunch', 800]]);
    t.writes[0]!.reject(new SattleError('invalid_input', 'Only Om can change this.'));
    await settle();
    expect(expensesOf(t.data).map((e) => e.description)).toEqual(['Lunch']);
    expect(t.data.getNotices().map((n) => n.text)).toEqual(['Only Om can change this.']);
  });

  it('two changes to one expense reach the server in the order they were made', async () => {
    const t = await synced(world([goa([lunch]), flat()]));
    track(t.data);
    t.data.editExpense('e-lunch', { ...dinner, description: 'One' });
    t.data.editExpense('e-lunch', { ...dinner, description: 'Two' });
    await settle();
    expect(t.writes.map((w) => (w.args[1] as ExpenseInput).description)).toEqual(['One']);
    t.writes[0]!.resolve({ ...lunch, description: 'One' });
    await settle();
    expect(t.writes.map((w) => (w.args[1] as ExpenseInput).description)).toEqual(['One', 'Two']);
    expect(expensesOf(t.data)[0]!.description).toBe('Two');
  });

  it('a delete takes it off at once, and one already gone elsewhere is just as done', async () => {
    const t = await synced(world([goa([lunch]), flat()]));
    track(t.data);
    t.data.deleteExpense('g-goa', 'e-lunch');
    expect(expensesOf(t.data)).toEqual([]);
    t.writes[0]!.reject(new SattleError('not_found', 'That expense doesn’t exist.'));
    await settle();
    expect(expensesOf(t.data)).toEqual([]);
    expect(t.data.getNotices()).toEqual([]);
  });

  it('deleting one that never saved just forgets it, with nothing sent', async () => {
    const t = await synced();
    track(t.data);
    const id = t.data.addExpense(dinner);
    t.writes[0]!.reject(new SattleError('invalid_expense', 'No.'));
    await settle();
    t.data.deleteExpense('g-goa', id);
    expect(t.writes).toHaveLength(1);
    expect(t.data.getChanges()).toEqual([]);
  });
});

describe('the order things land in', () => {
  const lunch = expense('e-lunch', 'g-goa', 600, 'm-riya', ['m-riya', 'm-om'], 'Lunch');

  it('lets an edit that didn’t get through go once a newer one is made, so it can’t land after it', async () => {
    const t = await synced(world([goa([lunch]), flat()]));
    track(t.data);
    t.data.editExpense('e-lunch', { ...dinner, description: 'One' });
    t.writes[0]!.reject(new SattleError('network', 'offline'));
    await settle();
    t.data.editExpense('e-lunch', { ...dinner, description: 'Two' });
    await settle();
    t.writes[1]!.resolve({ ...lunch, description: 'Two' });
    await settle();
    // Every sync from here works, long after any backoff: still nothing older goes after it.
    vi.useFakeTimers({ now: Date.now() + 120_000 });
    // The server has Two now, as each sync says.
    const now = answer(world([goa([{ ...lunch, description: 'Two' }]), flat()]));
    for (let i = 0; i < 4; i++) {
      for (const pending of t.syncs.splice(1)) pending.resolve(now);
      void t.data.sync();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(t.writes.map((w) => (w.args[1] as ExpenseInput).description)).toEqual(['One', 'Two']);
    expect(expensesOf(t.data)[0]!.description).toBe('Two');
  });

  it('shows an add whose answer was lost once, never beside the copy the server already has', async () => {
    const t = await synced();
    track(t.data);
    t.data.addExpense(dinner);
    t.writes[0]!.reject(new SattleError('network', 'The server took too long to answer.'));
    await settle();
    const real = expense('e-dinner', 'g-goa', 900, 'm-riya', ['m-riya', 'm-om'], 'Dinner');
    // It did get there: a sync has it under its real id. That answer isn't used, and the add goes again at once.
    const s1 = t.data.sync();
    t.syncs[1]!.resolve(answer(world([goa([real]), flat()])));
    expect(await s1).toBe(false);
    expect(expensesOf(t.data).map((e) => e.description)).toEqual(['Dinner']);
    expect(t.writes).toHaveLength(2);
    expect(t.writes[1]!.key).toBe(t.writes[0]!.key);
    // Answered as the first time; then the sync it brings is used, still with one Dinner.
    t.writes[1]!.resolve(real);
    await settle();
    expect(expensesOf(t.data).map((e) => e.id)).toEqual(['e-dinner']);
    t.syncs[2]!.resolve(answer(world([goa([real]), flat()])));
    await settle();
    expect(expensesOf(t.data).map((e) => e.id)).toEqual(['e-dinner']);
    expect(groupViewOf(t.data.getView()!, 'g-goa')!.myNet).toBe(450);
  });

  it('runs one sync at a time, even for a caller that syncs again the moment its own is done', async () => {
    const t = await synced();
    track(t.data);
    const first = t.data.sync();
    // A caller waiting on the first (as New group does), who syncs again as soon as it's done…
    const caller = first.then(() => void t.data.sync(['g-flat']));
    // …and one asked for while it was on its way, which waits for it.
    const queued = t.data.sync(['g-goa']);
    t.syncs[1]!.resolve({ version: 'v', unchanged: true });
    await caller;
    await settle();
    // The caller's joins the one waiting, rather than going beside it.
    expect(t.syncs).toHaveLength(3);
    expect([...t.syncs[2]!.groups!].sort()).toEqual(['g-flat', 'g-goa']);
    t.syncs[2]!.resolve({ version: 'v', unchanged: true });
    expect(await queued).toBe(true);
  });

  it('takes an answer it can’t read as a failed sync, and goes on to the next', async () => {
    const t = await synced();
    track(t.data);
    const bad = t.data.sync();
    const next = t.data.sync(['g-goa']);
    t.syncs[1]!.resolve({} as SyncAnswer);
    expect(await bad).toBe(false);
    expect(t.data.getStatus()).toMatchObject({ syncing: true });
    await settle();
    t.syncs[2]!.resolve({ version: 'v', unchanged: true });
    expect(await next).toBe(true);
    expect(t.data.getStatus()).toMatchObject({ syncing: false, error: null });
  });

  it('sends one the server is still working on again with the same key, never a new one', async () => {
    const t = await synced();
    track(t.data);
    t.data.addExpense(dinner);
    t.writes[0]!.reject(new SattleError('conflict', 'That request is still being processed.'));
    await settle();
    expect(t.data.getChanges()[0]).toMatchObject({ state: 'failed', error: { retry: true } });
    t.data.retry(t.data.getChanges()[0]!.id);
    expect(t.writes[1]!.key).toBe(t.writes[0]!.key);
  });
});

describe('when it stops', () => {
  it('writes nothing more after it stops: emptied first, nothing of the account is left behind', async () => {
    const saved = memoryStore();
    const t = await synced(world(), { saved, owner: 'me' });
    t.data.saveNow();
    expect(saved.text).not.toBeNull();
    t.data.clear();
    t.data.dispose();
    expect(saved.text).toBeNull();
  });

  it('hands its copy, and the changes still to send, to the same account under a new key', async () => {
    const saved = memoryStore();
    const t = await synced(world(), { saved, owner: 'old' });
    t.data.addExpense(dinner);
    t.data.handOver('new');
    t.data.dispose();
    expect(JSON.parse(saved.text!).owner).toBe('new');
    const { client } = fakeClient();
    const next = track(new AppData(client, { saved, owner: 'new' }));
    expect(next.getView()!.groups.map((g) => g.group.name)).toEqual(['Goa', 'Flat']);
    expect(next.getChanges().map((c) => c.kind)).toEqual(['add']);
  });
});

describe('what the server answered to other writes (known)', () => {
  it('shows at once, and stays until a sync that left after it lands', async () => {
    const t = await synced();
    track(t.data);
    const before = t.data.sync();
    t.data.known((v) => ({ ...v, groups: v.groups.filter((g) => g.group.id !== 'g-flat') }));
    expect(t.data.getView()!.groups.map((g) => g.group.id)).toEqual(['g-goa']);
    // This one left before: its answer still has Flat, and the known stays laid over it.
    t.syncs[1]!.resolve(answer(world()));
    await before;
    expect(t.data.getView()!.groups.map((g) => g.group.id)).toEqual(['g-goa']);
    const after = t.data.sync();
    t.syncs[2]!.resolve(answer(world([goa()])));
    await after;
    expect(t.data.getView()!.groups.map((g) => g.group.id)).toEqual(['g-goa']);
  });
});

// -- kept on the device -------------------------------------------------------------

describe('kept on the device', () => {
  it('opens at once on what it kept for this token, and not on another’s', async () => {
    const saved = memoryStore();
    const t = await synced(world(), { saved, owner: 'me' });
    t.data.saveNow();
    t.data.dispose();

    const { client } = fakeClient();
    const again = track(new AppData(client, { saved, owner: 'me' }));
    expect(again.getView()!.groups.map((g) => g.group.name)).toEqual(['Goa', 'Flat']);
    const someoneElse = track(new AppData(client, { saved, owner: 'not-me' }));
    expect(someoneElse.getView()).toBeNull();
    const nothingKept = track(new AppData(client, { saved: memoryStore('{not json'), owner: 'me' }));
    expect(nothingKept.getView()).toBeNull();
  });

  it('keeps a change the moment it’s made, and sends it again, with its key, after the app is opened', async () => {
    const saved = memoryStore();
    const t = await synced(world(), { saved, owner: 'me' });
    const writesBefore = saved.writes;
    t.data.addExpense(dinner);
    expect(saved.writes).toBe(writesBefore + 1);
    const key = t.writes[0]!.key;
    // Closed before the server answered.
    t.data.dispose();

    const next = fakeClient();
    const reopened = track(new AppData(next.client, { saved, owner: 'me' }));
    expect(reopened.getChanges()[0]).toMatchObject({ kind: 'add', state: 'failed', error: { retry: true } });
    const first = reopened.sync();
    next.syncs[0]!.resolve({ version: next.syncs[0]!.version ?? 'v', unchanged: true });
    await first;
    expect(next.writes).toHaveLength(1);
    expect(next.writes[0]).toMatchObject({ kind: 'add', key });
  });

  it('never keeps what a screen didn’t mark to keep', async () => {
    const saved = memoryStore();
    const t = await synced(world(), { saved, owner: 'me' });
    t.data.remember('link:g-goa', { token: 'secret-token' });
    t.data.remember('history:g-goa', [{ kind: 'added' }], true);
    t.data.saveNow();
    expect(saved.text).not.toContain('secret-token');
    expect(saved.text).toContain('history:g-goa');
    t.data.dispose();
  });

  it('keeps nothing without an owner', async () => {
    const saved = memoryStore();
    const t = await synced(world(), { saved, owner: null });
    t.data.addExpense(dinner);
    t.data.saveNow();
    expect(saved.text).toBeNull();
    t.data.dispose();
  });
});

describe('tokenFingerprint', () => {
  it('names a token the same way every time, and two tokens differently', () => {
    expect(tokenFingerprint('t-abc')).toBe(tokenFingerprint('t-abc'));
    expect(tokenFingerprint('t-abc')).not.toBe(tokenFingerprint('t-abd'));
    expect(tokenFingerprint('t-abc')).not.toContain('abc');
  });
});
