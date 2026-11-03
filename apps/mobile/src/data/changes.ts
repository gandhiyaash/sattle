/**
 * What this device has changed and the server hasn't shown back yet.
 *
 * An expense added, changed or deleted here shows at once, before the server
 * has answered: the screen is the server's last answer with these laid over
 * it (`applyChanges`). That is what makes Save feel instant, as on Splitwise.
 *
 * A change goes through three states:
 *
 *   sending   on its way. An added expense shows under the change's own id,
 *             and counts in the balances like any other.
 *   failed    refused, or lost on the way. `error.retry` says whether trying
 *             again could work (a network failure) or not (the server said no).
 *             One that will go again stays where it was, marked, and counts
 *             as it did. An added expense the server refused shows as not
 *             saved, apart from the rest, and counts in nothing until it's
 *             sent again or deleted.
 *   done      the server has it. Kept, with the server's answer (`result`),
 *             until a sync started after it lands, so a sync that left before
 *             the change got there can't take it off the screen again.
 *
 * Changes are plain data, so they're kept on the device with the rest
 * (AppData), and one made just before the app was closed is still sent.
 * Every retry sends the same idempotency key (`key`), so the server never
 * does one twice.
 */

import { isHeldBy, resolveParts, type Expense, type ExpenseInput, type GroupSnapshot, type SyncView } from '@sattle/core';

export type ChangeState = 'sending' | 'failed' | 'done';

interface ChangeBase {
  /** This device's name for the change. An added expense shows under it until the server's id arrives. */
  id: string;
  groupId: string;
  /** The idempotency key, the same for every attempt. */
  key: string;
  state: ChangeState;
  /** Why it failed, for the person; and whether sending it again could work. */
  error?: { message: string; code?: string; retry: boolean };
  /** For `done`: how many syncs had started when the server answered. One started after that has it. */
  doneAt?: number;
  /** When it was made, as the server would stamp it. */
  madeAt: string;
  /** How many times it has been sent, and when it last was (ms). For waiting longer between tries. */
  tries?: number;
  triedAt?: number;
}

export type Change =
  | (ChangeBase & { kind: 'add'; input: ExpenseInput; result?: Expense })
  | (ChangeBase & { kind: 'edit'; expenseId: string; input: ExpenseInput; result?: Expense })
  | (ChangeBase & { kind: 'delete'; expenseId: string });

/** Whether an expense on screen is one of this device's, still to be confirmed. */
export type ExpenseMark = { state: 'sending' } | { state: 'failed'; change: Change };

/** The prefix of the ids an added expense shows under until the server's arrives. */
export const LOCAL_ID = 'local-';

export const isLocalId = (id: string) => id.startsWith(LOCAL_ID);

/**
 * The expense an added or changed one will be, as the server would make it.
 * The parts are resolved with the same function the server uses, so the
 * balances shown don't move when the real one arrives.
 */
export function draftExpense(
  id: string,
  input: ExpenseInput,
  currency: string,
  createdAt: string,
  addedByMemberId?: string
): Expense {
  let parts;
  try {
    parts = resolveParts(input, currency);
  } catch {
    // The form only saves splits that add up; if one slipped through, the server will refuse it too.
    parts = input.parts.map((p) => ({ memberId: p.memberId, amount: p.amount ?? 0 }));
  }
  return {
    id,
    groupId: input.groupId,
    description: input.description,
    amount: input.amount,
    paidByMemberId: input.paidByMemberId,
    splitMode: input.splitMode,
    parts,
    createdAt,
    ...(addedByMemberId ? { addedByMemberId } : {}),
  };
}

/**
 * The view the screens show: the server's answer with this device's changes
 * laid over it, oldest first. Returns `view` itself when there's nothing to
 * lay over, so a screen only redraws when something did change.
 *
 * A change that couldn't get through stays laid over while it's to be sent
 * again. An add the server refused is kept out of the expenses (it isn't one);
 * the screens list it separately (`unsavedIn`). A refused change or delete is
 * dropped by AppData, and the expense shows as the server has it.
 */
export function applyChanges(view: SyncView, changes: readonly Change[]): SyncView {
  const live = changes.filter((c) => c.state !== 'failed' || c.error?.retry);
  if (live.length === 0) return view;
  const byGroup = new Map<string, Change[]>();
  for (const c of live) byGroup.set(c.groupId, [...(byGroup.get(c.groupId) ?? []), c]);
  let touched = false;
  const groups = view.groups.map((g) => {
    const mine = byGroup.get(g.group.id);
    if (!mine) return g;
    touched = true;
    return applyToGroup(g, mine, view.user.id);
  });
  return touched ? { ...view, groups } : view;
}

function applyToGroup(g: GroupSnapshot, changes: Change[], userId: string): GroupSnapshot {
  let expenses = g.expenses;
  const me = g.members.find((m) => isHeldBy(m, userId));
  for (const c of changes) {
    if (c.kind === 'add') {
      const added = c.result ?? draftExpense(c.id, c.input, g.group.currency, c.madeAt, me?.id);
      // Already in the answer under its real id: a sync after it got there.
      if (expenses.some((e) => e.id === added.id)) continue;
      expenses = [...expenses, added];
    } else if (c.kind === 'edit') {
      const i = expenses.findIndex((e) => e.id === c.expenseId);
      // Gone from the server (deleted on another phone): nothing left to change.
      if (i < 0) continue;
      const was = expenses[i];
      const now = c.result ?? draftExpense(was.id, c.input, g.group.currency, was.createdAt, was.addedByMemberId);
      expenses = [...expenses.slice(0, i), now, ...expenses.slice(i + 1)];
    } else {
      if (!expenses.some((e) => e.id === c.expenseId)) continue;
      expenses = expenses.filter((e) => e.id !== c.expenseId);
    }
  }
  return expenses === g.expenses ? g : { ...g, expenses };
}

/** How each expense id on screen stands, for the group's list: saving, or not saved. */
export function marksFor(groupId: string, changes: readonly Change[]): Map<string, ExpenseMark> {
  const marks = new Map<string, ExpenseMark>();
  for (const c of changes) {
    if (c.groupId !== groupId) continue;
    if (c.kind === 'add' && !c.result) {
      if (c.state === 'sending') marks.set(c.id, { state: 'sending' });
      else if (c.state === 'failed' && c.error?.retry) marks.set(c.id, { state: 'failed', change: c });
    } else if (c.kind === 'edit' && !c.result) {
      if (c.state === 'sending') marks.set(c.expenseId, { state: 'sending' });
      else if (c.state === 'failed') marks.set(c.expenseId, { state: 'failed', change: c });
    }
  }
  return marks;
}

/** An added expense that didn't save, and why. */
export interface Unsaved {
  expense: Expense;
  reason: string;
  /**
   * The server never answered it (rather than said no): sending it again,
   * with its key, is safe and may work. Otherwise it was refused as it is,
   * and wants changing.
   */
  unanswered: boolean;
}

/** Added expenses in a group that the server refused, newest first, as drafts to show in its list. */
export function unsavedIn(changes: readonly Change[], g: GroupSnapshot | undefined, userId: string | undefined): Unsaved[] {
  if (!g) return [];
  const me = userId ? g.members.find((m) => isHeldBy(m, userId)) : undefined;
  return changes
    .filter(
      (c): c is Extract<Change, { kind: 'add' }> =>
        c.kind === 'add' && c.groupId === g.group.id && c.state === 'failed' && !c.error?.retry
    )
    .map((c) => ({
      expense: draftExpense(c.id, c.input, g.group.currency, c.madeAt, me?.id),
      reason: c.error?.message ?? 'It didn’t save.',
      unanswered: c.error?.code === 'network' || c.error?.code === 'conflict',
    }))
    .reverse();
}

/**
 * Whether a group has changes the server hasn't confirmed that count in what
 * it shows: on their way, or to go again. Settling up, marking as settled
 * and reminding wait for them: what's owed is about to move, and a payment
 * for the old amount would be wrong.
 */
export const isUnconfirmed = (groupId: string, changes: readonly Change[]) =>
  changes.some((c) => c.groupId === groupId && (c.state === 'sending' || (c.state === 'failed' && c.error?.retry)));
