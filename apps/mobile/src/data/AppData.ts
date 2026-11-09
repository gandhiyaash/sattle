/**
 * What the app knows, and where every screen reads it from.
 *
 * Splitwise opens on what it saved and catches up behind it; this does the
 * same. One request, GET /sync, answers for everything the main screens show
 * (SyncView), and a copy is kept on the device, so a screen has what it needs
 * the moment it's opened, even the first time after a launch, and nothing waits
 * on the network to change screens. The server is asked again in the
 * background: when the app starts, every few seconds while a screen that
 * shows balances is up (`keepCurrent`), when the app comes back to the front,
 * and after every change. With `version`, a sync where nothing changed is a
 * few bytes.
 *
 * The user's own changes to expenses don't wait for the server either. Saving
 * one lays it over the server's answer at once (see changes.ts) and sends it
 * behind. Other writes (a settlement, a rename, a member) still go to the
 * server first, since they can be refused for reasons the app can't see, but
 * what the server answers is shown at once (`known`) rather than after a
 * second round trip.
 *
 * Two rules keep the screen from stepping back or doubling up:
 *
 * - A change the server has answered stays laid over until a sync that
 *   started after the answer lands. One that left earlier may not have it.
 * - While an added expense is still on its way it has no id from the server,
 *   so a sync answer that has it already couldn't be told apart from the one
 *   laid over. Such an answer isn't used; the add's own answer brings a sync
 *   that is.
 *
 * Kept on the device: the last answer, the changes still to be confirmed, and
 * the few other reads a screen marks to keep (`remember`). The changes are
 * kept apart from the rest (SavedPart): the rest is only a copy, which a sync
 * rebuilds, and may be kept where a phone short of space throws it away; the
 * changes are found nowhere else until the server has them. Not kept: anything
 * that works as a key (a group link, the ledger's backup key, a pay link),
 * which only ever lives in memory. The copy is for one account (`owner`, from
 * its token) and is dropped with it.
 */

import { SattleError, type Expense, type ExpenseInput, type GroupSnapshot, type SyncAnswer, type SyncView } from '@sattle/core';
import { newIdempotencyKey, type SattleClient } from '../client/SattleClient';
import { applyChanges, isLocalId, LOCAL_ID, type Change } from './changes';

/**
 * What's kept, in two parts: `copy`, the server's last answer and the reads
 * kept with it, which a sync can rebuild; and `changes`, the user's own
 * changes still to be confirmed, which only this device has. A store may
 * keep the copy somewhere it can be thrown away, never the changes.
 */
export type SavedPart = 'copy' | 'changes';

/** Where it's kept between launches: each part one string, read and written whole. */
export interface SavedStore {
  read(part: SavedPart): string | null;
  write(part: SavedPart, text: string): void;
  /** Both parts. */
  clear(): void;
}

export interface SyncStatus {
  /** When the server last answered, or null if it never has for this copy. */
  syncedAt: number | null;
  syncing: boolean;
  /** Why the last sync didn't work. Null once one has. */
  error: SattleError | null;
}

/** A line to tell the person, about one of their changes the server refused. */
export interface Notice {
  id: number;
  groupId: string;
  text: string;
}

export interface AppDataOptions {
  saved?: SavedStore | null;
  /** Whose copy this is (tokenFingerprint). Without one, nothing is kept on the device. */
  owner?: string | null;
  /** The server no longer knows the token: the account is gone from this device. */
  onSignedOut?: () => void;
  now?: () => number;
}

/**
 * Bump when the kept copy of the server's answer changes shape. An older copy
 * is dropped, and the app reads afresh. 2: each group has its `log`.
 */
const COPY_VERSION = 2;
/**
 * Bump when the kept changes change shape. Apart from the copy's, so a new
 * field in what the server answers never costs anyone a change not yet sent.
 */
const CHANGES_VERSION = 1;
/** How many times an add that goes unanswered is sent before it's left for the person to try again. */
const GIVE_UP_AFTER = 5;
/** Slowest a screen that keeps itself current is checked when syncs keep failing. */
const MAX_BACKOFF_MS = 30_000;
/** An older server answers a sync from its old routes, many requests at a time: ask it less often. */
const OLD_SERVER_MS = 15_000;

interface Known {
  /** How many syncs had started when the server answered. */
  at: number;
  /** The group it's about. One about none (a request to join taken back) waits for a sync of everything. */
  groupId?: string;
  apply: (view: SyncView) => SyncView;
}

/** Which groups a sync asks for: null for everything. */
type Scope = readonly string[] | null;

const keyOf = (scope: Scope) => (scope ? [...scope].sort().join(',') : '*');
const merge = (a: Scope, b: Scope): Scope => (a === null || b === null ? null : [...new Set([...a, ...b])]);
/** Whether an answer for `scope` says how `groupId` stands now. */
const covers = (scope: Scope, groupId: string | undefined) => scope === null || (groupId !== undefined && scope.includes(groupId));

interface SavedBlob {
  v: number;
  owner: string;
  version?: string;
  syncedAt: number | null;
  server: SyncView | null;
  /** Only in a copy from before the changes were kept apart (SavedChanges). */
  changes?: Change[];
  reads?: Record<string, { value: unknown; at: number }>;
}

interface SavedChanges {
  v: number;
  owner: string;
  changes: Change[];
}

type AddChange = Extract<Change, { kind: 'add' }>;

export class AppData {
  private server: SyncView | null = null;
  /**
   * The version of the last answer, by what it was for (keyOf). Only the
   * last changed answer's is kept: after one, the copy is newer than any
   * other version said, and a 304 against an older one could hide a change.
   */
  private versions = new Map<string, string>();
  /** When each kind of sync was last answered (keyOf), for isFresh. */
  private answeredAt = new Map<string, number>();
  private changes: Change[] = [];
  private knowns: Known[] = [];
  private reads = new Map<string, { value: unknown; at: number; save: boolean }>();
  private view: SyncView | null = null;
  private status: SyncStatus = { syncedAt: null, syncing: false, error: null };
  private noticeList: Notice[] = [];
  /** How many holdSignOut()s are in force. */
  private holds = 0;
  /**
   * Whether a sync has worked since this started. A token turned away
   * before then is the check the app always made at launch: the device is
   * signed out. One turned away later is left as an error, as before,
   * until the next launch makes that check: a server that has lost its
   * database for a moment shouldn't sign every phone out as it polls.
   */
  private answered = false;
  private noticeId = 0;
  private listeners = new Set<() => void>();

  /** Syncs started. A change answered when this was n is in every sync numbered above n. */
  private started = 0;
  private running: Promise<boolean> | null = null;
  private queued: { scope: Scope; promise: Promise<boolean> } | null = null;
  /** The number of the last sync whose answer was used. One that started before it is older news. */
  private applied = 0;
  private failures = 0;

  /** What each screen keeping itself current asked for, by registration: how often, and which group. */
  private wants = new Map<number, { ms: number; groupId?: string }>();
  private wantId = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private active = true;

  /** The last send for each expense, so a second change to it goes after the first. */
  private chain = new Map<string, Promise<void>>();
  private saveTimer?: ReturnType<typeof setTimeout>;
  /** The changes as last written, so a save that leaves them as they were doesn't write them again. */
  private changesWritten?: string;
  private disposed = false;
  private readonly now: () => number;

  constructor(
    private readonly client: SattleClient,
    private readonly opts: AppDataOptions = {}
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.hydrate();
  }

  // -- reading ---------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The server's last answer with this device's changes laid over it, or null before there's been one. */
  getView = (): SyncView | null => this.view;

  getStatus = (): SyncStatus => this.status;

  /** Every change still to be confirmed, oldest first. */
  getChanges = (): readonly Change[] => this.changes;

  /** Refused changes to tell the person about, oldest first. See `dismiss`. */
  getNotices = (): readonly Notice[] => this.noticeList;

  /** Whether the server has answered for everything, or for this group, within the last `ms`. */
  isFresh(ms: number, groupId?: string): boolean {
    const at = Math.max(this.answeredAt.get(keyOf(null)) ?? 0, groupId ? (this.answeredAt.get(groupId) ?? 0) : 0);
    return at > 0 && this.now() - at < ms;
  }

  /** A read kept under `key` by `remember`, with when it was read. */
  recall<T>(key: string): { value: T; at: number } | undefined {
    const r = this.reads.get(key);
    return r && { value: r.value as T, at: r.at };
  }

  /**
   * Keeps a read for the screen that made it to open on next time. `save`
   * keeps it on the device too: never for anything that works as a key.
   */
  remember(key: string, value: unknown, save = false): void {
    this.reads.set(key, { value, at: this.now(), save });
    if (save) this.saveSoon();
  }

  // -- syncing ---------------------------------------------------------------

  /**
   * Asks the server for everything, or for these groups only. Resolves once
   * a sync that started at or after this call, and covers what it asked for,
   * has finished: true if its answer was used, false if it failed (see
   * getStatus) or had to be set aside (the second rule at the top).
   * One sync is on its way at a time.
   */
  sync(groups?: readonly string[]): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const scope: Scope = groups ?? null;
    // Already one to come after the one on its way: this is part of it.
    if (this.queued) {
      this.queued.scope = merge(this.queued.scope, scope);
      return this.queued.promise;
    }
    if (!this.running) return this.start(scope);
    // One is on its way, but it left before this was asked: another after it, for all that's been asked since.
    const queued: { scope: Scope; promise: Promise<boolean> } = { scope, promise: Promise.resolve(false) };
    const next = () => {
      this.queued = null;
      return this.disposed ? false : this.start(queued.scope);
    };
    queued.promise = this.running.then(next, next);
    this.queued = queued;
    return queued.promise;
  }

  private start(scope: Scope): Promise<boolean> {
    // With nothing known yet, an answer for a few groups would be all there is: the first is for everything.
    const run: Promise<boolean> = this.run(this.server ? scope : null)
      .catch((e: unknown) => {
        // Something in handling the answer threw: the sync failed, and the next one can still go.
        if (!this.disposed) this.setStatus({ syncing: false, error: asSattleError(e) });
        return false;
      })
      .finally(() => {
        if (this.running === run) this.running = null;
      });
    this.running = run;
    return run;
  }

  private async run(scope: Scope): Promise<boolean> {
    if (this.disposed) return false;
    const s = ++this.started;
    const key = keyOf(scope);
    this.setStatus({ syncing: true });
    let answer: SyncAnswer;
    try {
      answer = await this.client.sync(this.server ? this.versions.get(key) : undefined, scope ?? undefined);
      if (!answer.unchanged && !(Array.isArray(answer.groups) && answer.user)) {
        throw new SattleError('network', 'The server’s answer couldn’t be read. Try again.');
      }
    } catch (e) {
      if (this.disposed) return false;
      const error = asSattleError(e);
      if (error.code === 'unauthorized' && this.holds === 0 && !this.answered) {
        this.setStatus({ syncing: false, error });
        this.signedOut();
        return false;
      }
      this.failures++;
      this.setStatus({ syncing: false, error });
      this.schedule();
      return false;
    }
    if (this.disposed) return false;
    this.failures = 0;
    this.answered = true;
    // Only one sync is on its way at a time, so this is defence: an answer older than one already used is news no more.
    if (s < this.applied) {
      this.setStatus({ syncing: false, error: null });
      return false;
    }

    // Whether the copy, the changes or the knowns moved: if none did, there's nothing to redraw or keep.
    let moved = false;
    if (answer.unchanged) {
      this.versions.set(key, answer.version);
    } else {
      // See the second rule at the top. An add waiting to go again is as unknown as one on its way:
      // the server may have it already. Each goes again now, and its answer brings a sync that can be used.
      const unsure = this.changes.filter(
        (c) => c.kind === 'add' && (c.state === 'sending' || (c.state === 'failed' && c.error?.retry)) && covers(scope, c.groupId)
      );
      if (unsure.length > 0) {
        for (const c of unsure) if (c.state === 'failed') this.resend(c.id);
        this.setStatus({ syncing: false, error: null });
        this.schedule();
        return false;
      }
      const { version, unchanged: _unchanged, ...view } = answer;
      // Another account answered (this device signed in as someone else): nothing here is theirs.
      if (this.server && this.server.user.id !== view.user.id) {
        this.server = null;
        this.changes = [];
        this.knowns = [];
        this.reads.clear();
      }
      const next = scope && this.server ? mergeGroups(this.server, view, scope) : share(this.server, view);
      // An answer that says what the copy already did leaves the other versions true.
      if (next !== this.server) {
        moved = true;
        this.versions.clear();
      }
      this.server = next;
      this.versions.set(key, version);
    }

    // What this sync has, by the first rule at the top.
    const pending = this.changes.length + this.knowns.length;
    this.changes = this.changes.filter((c) => !(c.state === 'done' && (c.doneAt ?? 0) < s && covers(scope, c.groupId)));
    this.knowns = this.knowns.filter((k) => !(k.at < s && (scope === null || covers(scope, k.groupId))));
    // A group the user is no longer in takes its changes and its reads with it: nothing there could
    // show them, or send them, and a left group's history has no business staying on the device.
    if (scope === null && this.server) {
      const groups = new Set(this.server.groups.map((g) => g.group.id));
      this.changes = this.changes.filter((c) => c.state === 'sending' || groups.has(c.groupId));
      for (const key of [...this.reads.keys()]) {
        const id = /^[a-z-]+:(.+)$/.exec(key)?.[1];
        if (id !== undefined && key !== 'upi' && !groups.has(id) && /^(history|link|upi-link):/.test(key)) {
          this.reads.delete(key);
          moved = true;
        }
      }
    }
    if (this.changes.length + this.knowns.length !== pending) moved = true;
    this.applied = s;
    if (moved) this.recompute();
    this.answeredAt.set(key, this.now());
    this.setStatus({ syncing: false, error: null, syncedAt: this.now() });
    // Written out only when something it holds changed: a sync every few seconds that changed
    // nothing shouldn't cost the phone a write of the whole copy.
    if (moved) this.saveSoon();
    this.resendLost();
    this.schedule();
    return true;
  }

  /**
   * Asks for the server to be checked every `ms` while the app is in front,
   * until the returned function is called: for one group, or with no
   * `groupId` for everything. The screens that show balances do, so a payment
   * or someone else's spend appears by itself. With several asking, the most
   * often wins, and the check covers all they asked for.
   */
  keepCurrent(ms: number, groupId?: string): () => void {
    const id = ++this.wantId;
    this.wants.set(id, { ms, groupId });
    this.schedule();
    return () => {
      this.wants.delete(id);
      this.schedule();
    };
  }

  /** The app went to the background, or came back. Coming back, anything kept current is checked at once. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (!active) this.saveNow();
    else if (this.wants.size > 0) void this.sync(this.wanted() ?? undefined);
    this.schedule();
  }

  /** What the screens keeping themselves current cover, together: null for everything. */
  private wanted(): Scope {
    let scope: Scope = [];
    for (const w of this.wants.values()) scope = merge(scope, w.groupId ? [w.groupId] : null);
    return scope;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed || !this.active || this.wants.size === 0) return;
    let ms = Math.min(...[...this.wants.values()].map((w) => w.ms));
    if ([...this.versions.values()].includes('')) ms = Math.max(ms, OLD_SERVER_MS);
    ms = Math.min(ms * 2 ** Math.min(this.failures, 4), Math.max(ms, MAX_BACKOFF_MS));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sync(this.wanted() ?? undefined);
    }, ms);
  }

  // -- the user's own changes -------------------------------------------------

  /** Adds an expense. It shows at once, under the id returned, and is sent behind. */
  addExpense(input: ExpenseInput): string {
    const key = newIdempotencyKey();
    const change: AddChange = {
      kind: 'add',
      id: `${LOCAL_ID}${key}`,
      groupId: input.groupId,
      key,
      state: 'sending',
      madeAt: new Date(this.now()).toISOString(),
      input,
    };
    this.push(change);
    return change.id;
  }

  /** Replaces what an expense says, at once, and sends it behind. */
  editExpense(expenseId: string, input: ExpenseInput): void {
    const key = newIdempotencyKey();
    this.push({
      kind: 'edit',
      id: `edit-${key}`,
      groupId: input.groupId,
      key,
      state: 'sending',
      madeAt: new Date(this.now()).toISOString(),
      expenseId,
      input,
    });
  }

  /** Deletes an expense, at once, and tells the server behind. One that never saved just goes. */
  deleteExpense(groupId: string, expenseId: string): void {
    if (isLocalId(expenseId)) return this.discard(expenseId);
    const key = newIdempotencyKey();
    this.push({
      kind: 'delete',
      id: `delete-${key}`,
      groupId,
      key,
      state: 'sending',
      madeAt: new Date(this.now()).toISOString(),
      expenseId,
    });
  }

  /**
   * Sends a change that failed again, with the same key: one that did get
   * there is answered as the first time, never done twice.
   */
  retry(changeId: string): void {
    const change = this.changes.find((c) => c.id === changeId);
    if (!change || change.state !== 'failed') return;
    this.resend(changeId);
    this.saveNow();
  }

  /**
   * While a key is being replaced, the server turns the old token away before
   * the app has the new one: a refusal then isn't the device being signed out.
   * Call the returned function once the new token is in use, or the
   * replacing failed.
   */
  holdSignOut(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
    };
  }

  /**
   * Writes the copy as `owner`'s, the same account under a new key, and
   * stops this one: it would otherwise write again as the old key's. Works
   * after the server has turned this one's token away, which is when it's needed.
   */
  handOver(owner: string): void {
    const wasDisposed = this.disposed;
    this.disposed = false;
    this.saveNow(owner);
    this.disposed = true;
    if (!wasDisposed) this.stop();
  }

  /** Forgets a change that failed: an added expense that didn't save goes from the list. */
  discard(changeId: string): void {
    const change = this.changes.find((c) => c.id === changeId);
    if (!change || change.state === 'sending') return;
    this.changes = this.changes.filter((c) => c.id !== changeId);
    this.recompute();
    this.saveNow();
  }

  /**
   * What the server answered to a write made outside this file, shown at
   * once: `apply` makes the view as it is now. It stays laid over until a
   * sync that started after it lands, so the caller syncs next (the screens'
   * `onChanged` does) for whatever else the write moved.
   */
  known(apply: (view: SyncView) => SyncView, groupId?: string): void {
    this.knowns.push({ at: this.started, groupId, apply });
    this.recompute();
  }

  dismiss(noticeId: number): void {
    this.noticeList = this.noticeList.filter((n) => n.id !== noticeId);
    this.emit();
  }

  private push(change: Change): void {
    // A change or delete stands for the whole expense: one made before it that didn't get through
    // would only undo it if it went again. One still on its way is waited for (send's chain).
    if (change.kind !== 'add') {
      this.changes = this.changes.filter((c) => !(c.state === 'failed' && c.kind !== 'add' && c.expenseId === change.expenseId));
    }
    this.changes = [...this.changes, change];
    this.recompute();
    // Kept at once: a change made just before the app is closed is still sent next time.
    this.saveNow();
    void this.send(change);
  }

  private async send(change: Change): Promise<void> {
    const target = change.kind === 'add' ? change.id : change.expenseId;
    const before = this.chain.get(target);
    const attempt = (async () => {
      // A second change to the same expense goes once the first is answered, so the server sees them in order.
      if (before) await before;
      if (this.disposed) return;
      this.update(change.id, { tries: (this.find(change.id)?.tries ?? 0) + 1, triedAt: this.now() });
      try {
        let result: Expense | undefined;
        if (change.kind === 'add') result = await this.client.addExpense(change.input, change.key);
        else if (change.kind === 'edit') result = await this.client.updateExpense(change.expenseId, change.input, change.key);
        else await this.client.deleteExpense(change.groupId, change.expenseId, change.key);
        if (this.disposed) return;
        this.update(change.id, { state: 'done', doneAt: this.started, result, error: undefined });
        this.saveNow();
        // The sync that drops it: one that starts now has it.
        void this.sync([change.groupId]);
      } catch (e) {
        if (this.disposed) return;
        const error = asSattleError(e);
        // A newer change to the same expense has taken this one's place: it mustn't go again after it.
        if (change.kind !== 'add' && this.supersedes(change)) {
          this.changes = this.changes.filter((c) => c.id !== change.id);
          this.recompute();
          this.saveNow();
          return;
        }
        if (error.code === 'unauthorized' && this.holds === 0 && !this.answered) {
          // Kept to go again: the account may be about to carry on under a new key (handOver).
          this.update(change.id, { state: 'failed', error: { message: error.message, code: error.code, retry: true } });
          this.saveNow();
          this.signedOut();
          return;
        }
        // Still being worked on (its first try is), or the token is being swapped for a new one: as
        // unknown as a lost answer, so it goes again with the same key, which the server answers once it's done.
        const unsure = error.code === 'network' || error.code === 'unauthorized' || isStillProcessing(error);
        if (change.kind === 'delete' && error.code === 'not_found') {
          // Already gone, deleted on another phone: that's what was wanted.
          this.update(change.id, { state: 'done', doneAt: this.started, error: undefined });
          void this.sync([change.groupId]);
        } else if (unsure && (change.kind !== 'add' || (this.find(change.id)?.tries ?? 1) < GIVE_UP_AFTER)) {
          // It may or may not have got there. Sent again, with the same key, once a sync works (resendLost).
          this.update(change.id, { state: 'failed', error: { message: error.message, code: error.code, retry: true } });
        } else if (unsure) {
          // An add the server keeps not answering while syncs work holds up its group's syncs (the second
          // rule at the top), so after a few tries it's left for the person, shown as not saved. If it did get
          // there after all, Try again is answered with it (same key), and Delete takes the draft away.
          this.update(change.id, {
            state: 'failed',
            error: { message: 'The server hasn’t answered it after a few tries.', code: error.code, retry: false },
          });
        } else if (change.kind === 'add') {
          // Refused. It stays on the list as not saved, for the person to put right or delete. The group may
          // have moved under it (someone in the split taken out, say): it's read again for the form to show.
          this.update(change.id, { state: 'failed', error: { message: error.message, code: error.code, retry: false } });
          void this.sync([change.groupId]);
        } else {
          // A change or a delete the server refused: the expense shows as it has it, and the person is told.
          this.changes = this.changes.filter((c) => c.id !== change.id);
          this.recompute();
          this.notify(change.groupId, error.message);
          void this.sync([change.groupId]);
        }
        this.saveNow();
      }
    })();
    const settled = attempt.catch(() => {});
    this.chain.set(target, settled);
    await settled;
    if (this.chain.get(target) === settled) this.chain.delete(target);
  }

  /**
   * After a sync works: changes that didn't get through for want of a
   * connection go again, each waiting longer after every try (2 s, 4 s, …, a
   * minute), so one that keeps failing while syncs work can't turn into a flood.
   * One a newer change to the same expense has replaced is let go instead.
   */
  private resendLost(): void {
    const now = this.now();
    for (const c of this.changes) {
      if (c.state !== 'failed' || !c.error?.retry) continue;
      if (c.kind !== 'add' && this.supersedes(c)) {
        this.changes = this.changes.filter((x) => x.id !== c.id);
        this.recompute();
        continue;
      }
      const wait = Math.min(2000 * 2 ** Math.max((c.tries ?? 1) - 1, 0), 60_000);
      if (c.triedAt !== undefined && now - c.triedAt < wait) continue;
      this.resend(c.id);
    }
  }

  private resend(changeId: string): void {
    this.update(changeId, { state: 'sending', error: undefined });
    const change = this.find(changeId);
    if (change) void this.send(change);
  }

  /** Whether a change made after `change` is to the same expense, and so takes its place. */
  private supersedes(change: Change): boolean {
    if (change.kind === 'add') return false;
    const at = this.changes.findIndex((c) => c.id === change.id);
    return this.changes.some((c, i) => i > at && c.kind !== 'add' && c.expenseId === change.expenseId);
  }

  private find(changeId: string): Change | undefined {
    return this.changes.find((c) => c.id === changeId);
  }

  private update(changeId: string, patch: Partial<Change>): void {
    let found = false;
    this.changes = this.changes.map((c) => {
      if (c.id !== changeId) return c;
      found = true;
      return { ...c, ...patch } as Change;
    });
    if (found) this.recompute();
  }

  private notify(groupId: string, text: string): void {
    this.noticeList = [...this.noticeList, { id: ++this.noticeId, groupId, text }];
    this.emit();
  }

  // -- keeping it -------------------------------------------------------------

  private hydrate(): void {
    const { saved, owner } = this.opts;
    if (!saved || !owner) return;
    const ours = <T extends { v: number; owner: string }>(part: SavedPart, version: number): T | null => {
      try {
        const text = saved.read(part);
        const blob = text ? (JSON.parse(text) as T) : null;
        return blob && blob.v === version && blob.owner === owner ? blob : null;
      } catch {
        // Unreadable, or storage is blocked: nothing saved, as on a first launch.
        return null;
      }
    };
    const blob = ours<SavedBlob>('copy', COPY_VERSION);
    const kept = ours<SavedChanges>('changes', CHANGES_VERSION);
    if (blob?.server) {
      this.server = blob.server;
      if (blob.version !== undefined) this.versions.set(keyOf(null), blob.version);
      this.status = { syncedAt: blob.syncedAt ?? null, syncing: false, error: null };
      for (const [key, r] of Object.entries(blob.reads ?? {})) this.reads.set(key, { ...r, save: true });
    }
    // Without the copy (thrown away for space), the changes are still sent: the first sync brings
    // back what they're laid over. A copy from before they were kept apart has them in it.
    const changes = kept ? kept.changes : blob?.server ? (blob.changes ?? []) : [];
    // A change that was on its way when the app closed is sent again with the same key: the server
    // keeps an idempotency key and its answer for good (apps/api middleware), so a second send of
    // one that did get there is answered as the first was, instead of done twice.
    this.changes = changes.map((c): Change => {
      // Answered last time: the first sync has it.
      if (c.state === 'done') return { ...c, doneAt: 0 };
      if (c.state === 'sending' || (c.state === 'failed' && c.error?.retry)) {
        // Closed on its way, or waiting to go again: it goes with its key once a sync works, without
        // waiting out a backoff from before the app was closed.
        return { ...c, state: 'failed', error: { message: 'Not sent yet.', code: 'network', retry: true }, triedAt: undefined };
      }
      return c;
    });
    this.recompute(false);
  }

  private saveSoon(): void {
    if (!this.opts.saved || !this.opts.owner || this.disposed) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  /**
   * Writes the copy out now. Also when the app goes to the background. With
   * `owner`, it's written as that token's: the same account under a new key.
   */
  saveNow(owner = this.opts.owner): void {
    const { saved } = this.opts;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!saved || !owner || this.disposed) return;
    // The changes first, and even before there's a copy to lay them over: they're the part that
    // can't be got back.
    const changes: SavedChanges = { v: CHANGES_VERSION, owner, changes: this.changes };
    const changesText = JSON.stringify(changes);
    if (changesText !== this.changesWritten) {
      try {
        saved.write('changes', changesText);
        this.changesWritten = changesText;
      } catch {
        // Full or blocked: they're kept in memory, and tried again on the next save.
      }
    }
    if (!this.server) return;
    const reads: SavedBlob['reads'] = {};
    for (const [key, r] of this.reads) if (r.save) reads[key] = { value: r.value, at: r.at };
    const blob: SavedBlob = {
      v: COPY_VERSION,
      owner,
      version: this.versions.get(keyOf(null)),
      syncedAt: this.status.syncedAt,
      server: this.server,
      reads,
    };
    try {
      saved.write('copy', JSON.stringify(blob));
    } catch {
      // Full or blocked: it's kept in memory, and the next launch reads afresh.
    }
  }

  /** Forgets everything, here and on the device. */
  clear(): void {
    this.server = null;
    this.versions.clear();
    this.changes = [];
    this.knowns = [];
    this.reads.clear();
    this.status = { syncedAt: null, syncing: false, error: null };
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.changesWritten = undefined;
    try {
      this.opts.saved?.clear();
    } catch {
      // Nothing kept, then.
    }
    this.recompute();
  }

  /**
   * Stops every timer, and writes nothing more. The screens using this are
   * gone: the account moved to another token, or out. Changes were written
   * the moment they were made, so nothing is lost by not writing again, and a
   * write now could undo what replaced it (handOver, clear).
   */
  dispose(): void {
    this.disposed = true;
    this.stop();
    this.listeners.clear();
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.wants.clear();
  }

  /**
   * The server turned the token away. This copy stops: no more syncs, sends
   * or saves. What's kept on the device is left to `onSignedOut`, which knows
   * whether the token is still the one the device holds. One replaced by a new
   * key on purpose has had its copy handed on (saveNow with the new owner),
   * and must not take that with it.
   */
  private signedOut(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.opts.onSignedOut?.();
  }

  // -- telling the screens ----------------------------------------------------

  private recompute(emit = true): void {
    const base = this.server && this.knowns.reduce((v, k) => k.apply(v), this.server);
    this.view = base && applyChanges(base, this.changes);
    if (emit) this.emit();
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}

/**
 * The server's answer to a key it's still working on (apps/api middleware
 * idempotency): the first try is on its way through. Not a refusal, so the
 * change goes again with the same key, and is answered once that's done.
 */
function isStillProcessing(error: SattleError): boolean {
  return error.code === 'conflict' && /still being processed/i.test(error.message);
}

function asSattleError(e: unknown): SattleError {
  if (e instanceof SattleError) return e;
  return new SattleError('network', e instanceof Error ? e.message : String(e));
}

/**
 * A short, stable name for a token, to tell whose copy is saved without
 * keeping the token itself next to it. Not a secret and not for checking
 * anything: two tokens could share one, which only costs a fresh read.
 */
export function tokenFingerprint(token: string): string {
  // FNV-1a, twice with different seeds for 64 bits.
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 + 2) >>> 0;
  }
  return a.toString(36) + b.toString(36);
}

/** What each part of a view says, as JSON, worked out once per object: the copy is compared on every changed sync. */
const texts = new WeakMap<object, string>();
function textOf(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  let text = texts.get(value);
  if (text === undefined) texts.set(value, (text = JSON.stringify(value)));
  return text;
}

/** The same value as `was` if it says the same, so what shows it needn't draw again. */
function same<T>(was: T, now: T): T {
  return textOf(was) === textOf(now) ? was : now;
}

/**
 * A new answer for everything, with each part that says what it said before
 * kept as the very object it was. A sync where only one group changed then
 * redraws only what shows that group; one where nothing did, nothing.
 */
function share(was: SyncView | null, now: SyncView): SyncView {
  if (!was) return now;
  const old = new Map(was.groups.map((g) => [g.group.id, g]));
  const fresh = now.groups.map((g) => {
    const o = old.get(g.group.id);
    return o ? same(o, g) : g;
  });
  const groups = fresh.length === was.groups.length && fresh.every((g, i) => g === was.groups[i]) ? was.groups : fresh;
  const user = same(was.user, now.user);
  const joinRequests = same(was.joinRequests, now.joinRequests);
  const upiProfile = same(was.upiProfile, now.upiProfile);
  if (groups === was.groups && user === was.user && joinRequests === was.joinRequests && upiProfile === was.upiProfile) {
    return was;
  }
  return { user, groups, joinRequests, upiProfile };
}

/**
 * An answer for some groups, put into the copy of everything: each group
 * asked for as it now is, or gone if the answer left it out (the user isn't
 * in it any more). A group asked for that the copy didn't have yet (just
 * joined) goes where the server lists it, newest made first, so the next
 * sync of everything doesn't move it. Everything else stays as it was.
 */
function mergeGroups(was: SyncView, now: SyncView, scope: readonly string[]): SyncView {
  const fresh = new Map(now.groups.map((g) => [g.group.id, g]));
  const known = new Set(was.groups.map((g) => g.group.id));
  const groups: GroupSnapshot[] = [];
  for (const g of was.groups) {
    if (!scope.includes(g.group.id)) groups.push(g);
    else if (fresh.has(g.group.id)) groups.push(same(g, fresh.get(g.group.id)!));
  }
  for (const g of now.groups) {
    if (known.has(g.group.id)) continue;
    const at = groups.findIndex((x) => x.group.createdAt < g.group.createdAt);
    groups.splice(at < 0 ? groups.length : at, 0, g);
  }
  return share(was, { ...now, groups });
}
