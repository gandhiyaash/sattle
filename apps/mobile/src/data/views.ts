/**
 * What the main screens show, worked out from AppData's view. Pure, so it can
 * be tested, and cheap: a group of a few hundred expenses is well under a
 * millisecond. The screens keep the result with useMemo, so it's only worked
 * out again when the view itself changed.
 */

import {
  computeBalances,
  groupDebts,
  isHeldBy,
  type Debt,
  type Expense,
  type Group,
  type GroupSnapshot,
  type Member,
  type PendingJoin,
  type SyncView,
  type UpiClaim,
  type UpiProfile,
  type User,
} from '@sattle/core';

/** One tile on the groups list. */
export interface GroupRow {
  group: Group;
  net: number;
  memberCount: number;
  /** With none, a zero net means nothing has happened yet, not that it's settled. */
  expenseCount: number;
}

/** The groups list: each group, with where the user stands in it. In the server's order. */
export function groupRowsOf(view: SyncView): GroupRow[] {
  return view.groups.map(({ group, members, expenses, settlements }) => {
    const mine = members.find((m) => isHeldBy(m, view.user.id));
    const balances = computeBalances(group.memberIds, expenses, settlements);
    return {
      group,
      net: balances.find((b) => b.memberId === mine?.id)?.net ?? 0,
      memberCount: members.length,
      expenseCount: expenses.length,
    };
  });
}

/** Everything the group's screen shows. */
export interface GroupView {
  name: string;
  currency: string;
  members: Member[];
  /** Newest first. */
  expenses: Expense[];
  debts: Debt[];
  /** What the debts would be with Simplify debts the other way, for "Why these payments?". */
  otherDebts: Debt[];
  simplifyDebts: boolean;
  /** UPI payments someone says they made, to or from the user, that the person owed hasn't confirmed. */
  claims: UpiClaim[];
  /** People asking to join, waiting on someone here to let them in. */
  waiting: PendingJoin[];
  /** Group.approveJoins: whether the link lets people in, or lets them ask. */
  approveJoins: boolean;
  /** Ghosts that no expense or payment names. */
  removable: Set<string>;
  /** Each member's net in the group: positive is owed to them, negative is what they owe. */
  nets: Map<string, number>;
  /** Everything the group has spent, and the user's part of it. */
  spent: number;
  myShare: number;
  /** The user's own UPI ID, if they've given one. */
  upi: UpiProfile;
  userId: string;
  myMemberId: string | null;
  myNet: number;
}

/** The group's one entry in the view, or undefined when the user isn't in it (or it isn't known yet). */
export function snapshotOf(view: SyncView | null, groupId: string): GroupSnapshot | undefined {
  return view?.groups.find((g) => g.group.id === groupId);
}

export function groupViewOf(view: SyncView, groupId: string): GroupView | undefined {
  const g = snapshotOf(view, groupId);
  return g && groupViewFrom(g, view.user, view.upiProfile);
}

/** The same, from the group's entry and the two things about the user it needs. */
export function groupViewFrom(g: GroupSnapshot, user: User, upiProfile: UpiProfile): GroupView {
  const { group, members, expenses, settlements, upiClaims, pendingJoins } = g;

  const balances = computeBalances(group.memberIds, expenses, settlements);
  const mine = members.find((m) => isHeldBy(m, user.id)) ?? null;
  const named = new Set<string>();
  for (const e of expenses) {
    named.add(e.paidByMemberId);
    for (const p of e.parts) named.add(p.memberId);
  }
  for (const st of settlements) {
    named.add(st.fromMemberId);
    named.add(st.toMemberId);
  }

  return {
    name: group.name,
    currency: group.currency,
    members,
    expenses: [...expenses].reverse(),
    debts: groupDebts(group, expenses, settlements),
    otherDebts: groupDebts({ ...group, simplifyDebts: !group.simplifyDebts }, expenses, settlements),
    simplifyDebts: group.simplifyDebts,
    claims: upiClaims,
    waiting: pendingJoins,
    approveJoins: group.approveJoins,
    removable: new Set(members.filter((m) => !m.claimedByUserId && !named.has(m.id)).map((m) => m.id)),
    nets: new Map(balances.map((b) => [b.memberId, b.net])),
    spent: expenses.reduce((sum, e) => sum + e.amount, 0),
    myShare: expenses.reduce((sum, e) => sum + (e.parts.find((p) => p.memberId === mine?.id)?.amount ?? 0), 0),
    upi: upiProfile,
    userId: user.id,
    myMemberId: mine?.id ?? null,
    myNet: balances.find((b) => b.memberId === mine?.id)?.net ?? 0,
  };
}

// -- laying a write's answer over the view (AppData.known) ---------------------

/** The view with one group's entry changed by `fn`. Unchanged if the user isn't in it. */
export function withGroup(view: SyncView, groupId: string, fn: (g: GroupSnapshot) => GroupSnapshot): SyncView {
  let changed = false;
  const groups = view.groups.map((g) => {
    if (g.group.id !== groupId) return g;
    changed = true;
    return fn(g);
  });
  return changed ? { ...view, groups } : view;
}

/** Puts `item` in place of the one with its id, or adds it at the end. */
export function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  return i < 0 ? [...list, item] : [...list.slice(0, i), item, ...list.slice(i + 1)];
}

export const without = <T extends { id: string }>(list: T[], id: string): T[] => list.filter((x) => x.id !== id);

/**
 * The group with `member` in it: added, or over who they were (a ghost
 * someone became). Laid over what was known of them, since a write answers
 * with the member as stored, without what the members read works out for
 * each (whether they can be paid, whether they take UPI).
 */
export function withMember(g: GroupSnapshot, member: Member): GroupSnapshot {
  const memberIds = g.group.memberIds.includes(member.id) ? g.group.memberIds : [...g.group.memberIds, member.id];
  const was = g.members.find((m) => m.id === member.id);
  return { ...g, group: { ...g.group, memberIds }, members: upsert(g.members, was ? { ...was, ...member } : member) };
}
