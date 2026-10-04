/**
 * What the server last answered, kept on the device so the app opens on it
 * when there's no connection, the way it looked last time.
 *
 * Only reads are kept, under the path they were asked at, and only the ones
 * the main screens are built from: who you are, your groups and what's in
 * them, and where you get paid. Left out on purpose:
 *
 * - anything that works as a key (an invite, a group link, the ledger's
 *   backup key). This sits in ordinary storage; the account token doesn't.
 * - a payment in progress, where an old answer is worse than none.
 *
 * It all goes when the account does. See AccountGate in App.tsx.
 */

import type { Group, User } from '@sattle/core';

/** Where the copy lives between launches: one string, read and written whole. */
export interface SavedStore {
  read(): string | null;
  write(text: string): void;
  clear(): void;
}

/** Bump when an answer changes shape in a way an old copy would break a screen. Old copies are dropped. */
const VERSION = 1;

const KEPT = [
  /^\/health$/,
  /^\/me$/,
  /^\/me\/(wallet|receive-address|upi)$/,
  /^\/groups$/,
  /^\/groups\/[^/]+$/,
  /^\/groups\/[^/]+\/(members|expenses|settlements|debts|upi-claims)$/,
];

/** A new answer is written out once things go quiet. One that only confirmed what's saved can wait. */
const WRITE_MS = 500;
const CONFIRM_MS = 60_000;

export class SavedReads {
  /** Path to answer, as JSON. Null until first used, so storage isn't read before then. */
  private entries: Map<string, string> | null = null;
  /** The paths saved before the last change made from this device. */
  private outdated = new Set<string>();
  private answeredAt: number | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private due = 0;

  constructor(private readonly store: SavedStore) {}

  /** When the server last answered one of these reads. What's saved is as things stood then. */
  get at(): number | null {
    this.open();
    return this.answeredAt;
  }

  /**
   * The saved answer to a read, or undefined. With `current`, one saved
   * before the last change made from here doesn't count: the server's answer
   * is about to replace it, and showing it first would undo the change on
   * screen for a moment.
   */
  get<T>(path: string, current = false): T | undefined {
    const json = this.open().get(path);
    if (json === undefined || (current && this.outdated.has(path))) return undefined;
    return JSON.parse(json) as T;
  }

  /** The server answered `path`. Kept if it's one of the reads worth keeping. */
  keep(path: string, value: unknown): void {
    if (!KEPT.some((p) => p.test(path))) return;
    // A different account answered. Nothing saved here is theirs to see.
    const was = path === '/me' ? this.get<User>('/me') : undefined;
    if (was && was.id !== (value as User).id) this.forget();

    let changed = this.set(path, value);
    if (path === '/groups') changed = this.keepGroups(value as Group[]) || changed;
    this.answeredAt = Date.now();
    this.writeSoon(changed ? WRITE_MS : CONFIRM_MS);
  }

  /** A change went through from this device, so every answer saved before it may be out of date. */
  outdate(): void {
    for (const path of this.open().keys()) this.outdated.add(path);
  }

  /** Forgets everything, here and in storage. */
  clear(): void {
    this.forget();
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      this.store.clear();
    } catch {
      // Nothing stored, then.
    }
  }

  private forget(): void {
    this.entries = new Map();
    this.outdated.clear();
    this.answeredAt = null;
  }

  private set(path: string, value: unknown): boolean {
    const entries = this.open();
    const json = JSON.stringify(value);
    const changed = entries.get(path) !== json;
    entries.set(path, json);
    this.outdated.delete(path);
    return changed;
  }

  /**
   * The list of groups is also each group on its own, so a group opens
   * offline even if it was never opened online. A group no longer on the list
   * was left or deleted, and what was saved of it goes.
   */
  private keepGroups(groups: Group[]): boolean {
    const entries = this.open();
    let changed = false;
    for (const group of groups) changed = this.set(`/groups/${group.id}`, group) || changed;

    const ids = new Set(groups.map((g) => g.id));
    for (const path of [...entries.keys()]) {
      const id = /^\/groups\/([^/]+)/.exec(path)?.[1];
      if (id === undefined || ids.has(id)) continue;
      entries.delete(path);
      this.outdated.delete(path);
      changed = true;
    }
    return changed;
  }

  private open(): Map<string, string> {
    if (this.entries) return this.entries;
    this.entries = new Map();
    try {
      const text = this.store.read();
      const blob = text ? (JSON.parse(text) as { v?: number; at?: number; entries?: Record<string, unknown> }) : null;
      if (blob?.v === VERSION && blob.entries) {
        for (const [path, json] of Object.entries(blob.entries)) {
          if (typeof json === 'string') this.entries.set(path, json);
        }
        this.answeredAt = blob.at ?? null;
      }
    } catch {
      // Unreadable, or storage is blocked: nothing saved, as on a first launch.
    }
    return this.entries;
  }

  private writeSoon(ms: number): void {
    const due = Date.now() + ms;
    if (this.timer && this.due <= due) return;
    clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.store.write(
          JSON.stringify({ v: VERSION, at: this.answeredAt, entries: Object.fromEntries(this.open()) })
        );
      } catch {
        // Storage is full or blocked. What's in memory still serves until the app closes.
      }
    }, ms);
  }
}
