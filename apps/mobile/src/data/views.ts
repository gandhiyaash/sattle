/**
 * What the main screens show, worked out from AppData's view. Pure, so it can
 * be tested, and cheap: a group of a few hundred expenses is well under a
 * millisecond. The screens keep the result with useMemo, so it's only worked
 * out again when the view itself changed.
 */

import {
  buildHistory,
  computeBalances,
  describeGroupChange,
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

/** One line of the Activity tab: an expense added, a debt settled, or a change to one of the user's groups. */
export interface ActivityItem {
  /** Unique across groups. */
  id: string;
  groupId: string;
  groupName: string;
  currency: string;
  at: string;
  kind: 'expense' | 'payment' | 'change';
  /**
   * The expense's description, who paid whom, or what changed and who changed
   * it ("Om turned on Simplify debts"), with "You" for the user.
   */
  title: string;
  /**
   * Who did it, where the title doesn't say: who added an expense (and who
   * paid it, if someone else), who marked a debt settled or confirmed a UPI
   * payment. Empty for a change, whose title says it all.
   */
  detail: string;
  /** 0 for a change. */
  amount: number;
  /**
   * What it did for the user, signed as a balance is: more than 0 they're owed
   * it, or it came to them; less than 0 they owe it, or they paid it. Null
   * when they weren't in it, and for a change.
   */
  mine: number | null;
}

/**
 * Every group's expenses, settled debts and changes to the group itself
 * (its log), newest first, as one list, each saying who did it. Read from
 * what the app already has from sync, so it needs nothing of its own from the
 * server. Edits and removals of expenses are each group's History; this is
 * what was spent, what was paid, and what changed about the groups.
 */
export function activityOf(view: SyncView, limit = 200): ActivityItem[] {
  const items: ActivityItem[] = [];
  // A server from before group logs (027) sends none, and that answer can be kept: read it as empty.
  for (const { group, members, expenses, settlements, log = [] } of view.groups) {
    const me = members.find((m) => isHeldBy(m, view.user.id))?.id;
    /** "You" for the user, at the start of a line; "you" further in. */
    const name = (id: string | undefined, start = true) =>
      id === undefined ? undefined : id === me ? (start ? 'You' : 'you') : (members.find((m) => m.id === id)?.displayName ?? 'Someone');
    for (const entry of buildHistory(expenses, [], settlements, log)) {
      const base = { id: `${group.id}:${entry.id}`, groupId: group.id, groupName: group.name, currency: group.currency, at: entry.at };
      if (entry.kind === 'expense_added') {
        const e = entry.expense;
        const part = e.parts.find((p) => p.memberId === me)?.amount ?? 0;
        const paid = e.paidByMemberId === me;
        const adder = e.addedByMemberId;
        items.push({
          ...base,
          kind: 'expense',
          title: e.description,
          // Who put it in, and who paid it if that was someone else. One from before adders were kept says who paid.
          detail: adder
            ? `Added by ${name(adder, false)}${adder === e.paidByMemberId ? '' : ` · ${name(e.paidByMemberId)} paid`}`
            : `${name(e.paidByMemberId)} paid`,
          amount: e.amount,
          mine: paid ? e.amount - part : part > 0 ? -part : null,
        });
      } else if (entry.kind === 'settled') {
        const st = entry.settlement;
        const by = name(st.recordedByMemberId, false);
        items.push({
          ...base,
          kind: 'payment',
          // Marked as settled covers cash and a debt let go, so it doesn't say that anything was paid.
          title: `${name(st.fromMemberId)} ${st.rail === 'manual' ? 'settled with' : 'paid'} ${name(st.toMemberId, false)}`,
          detail:
            st.rail === 'manual'
              ? by
                ? `Marked as settled by ${by}`
                : 'Marked as settled'
              : st.rail === 'upi'
                ? by && !st.upi
                  ? `UPI, confirmed by ${by}`
                  : 'UPI'
                : 'Lightning',
          amount: st.amount,
          mine: st.fromMemberId === me ? -st.amount : st.toMemberId === me ? st.amount : null,
        });
      } else if (entry.kind === 'group_changed') {
        items.push({
          ...base,
          kind: 'change',
          title: describeGroupChange(entry.change, name(entry.byMemberId)),
          detail: '',
          amount: 0,
          mine: null,
        });
      }
    }
  }
  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
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
