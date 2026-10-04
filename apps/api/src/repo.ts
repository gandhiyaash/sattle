/**
 * Row ↔ domain mapping. Everything that leaves this file is a domain type
 * from @sattle/core, so routes never see snake_case or NULLs.
 */

import { randomUUID } from 'node:crypto';

import {
  LEDGER_STATUSES,
  SattleError,
  TERMINAL_STATUSES,
  type Expense,
  type Debt,
  type Group,
  type GroupLink,
  type Invite,
  type Member,
  type PayLink,
  type Settlement,
  type User,
} from '@sattle/core';

import type { Db } from './db';

type Row = Record<string, unknown>;

/** NULL → undefined, so optional fields are absent from JSON, like the mock. */
const opt = <T>(v: unknown) => (v === null || v === undefined ? undefined : (v as T));

export const newId = (prefix: string) => `${prefix}-${randomUUID()}`;
export const nowIso = () => new Date().toISOString();

const toUser = (r: Row): User => ({ id: r.id as string, displayName: r.display_name as string });

const toMember = (r: Row): Member => ({
  id: r.id as string,
  groupId: r.group_id as string,
  displayName: r.display_name as string,
  status: r.status as Member['status'],
  claimedByUserId: opt(r.claimed_by_user_id),
  lightningAddress: opt(r.lightning_address),
});

const toExpense = (r: Row): Expense => ({
  id: r.id as string,
  groupId: r.group_id as string,
  description: r.description as string,
  amount: r.amount as number,
  paidByMemberId: r.paid_by_member_id as string,
  splitMode: r.split_mode as Expense['splitMode'],
  parts: JSON.parse(r.parts as string),
  createdAt: r.created_at as string,
});

const toSettlement = (r: Row): Settlement => ({
  id: r.id as string,
  groupId: r.group_id as string,
  fromMemberId: r.from_member_id as string,
  toMemberId: r.to_member_id as string,
  amount: r.amount as number,
  currency: r.currency as string,
  rail: r.rail as Settlement['rail'],
  status: r.status as Settlement['status'],
  quote: r.quote ? JSON.parse(r.quote as string) : undefined,
  destination: opt(r.destination),
  preimage: opt(r.preimage),
  note: opt(r.note),
  failureReason: opt(r.failure_reason),
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const toPayLink = (r: Row): PayLink => ({
  token: r.token as string,
  groupId: r.group_id as string,
  fromMemberId: r.from_member_id as string,
  toMemberId: r.to_member_id as string,
  amount: r.amount as number,
  createdAt: r.created_at as string,
});

const toGroupLink = (r: Row): GroupLink => ({
  token: r.token as string,
  groupId: r.group_id as string,
  createdAt: r.created_at as string,
});

const toInvite = (r: Row): Invite => ({
  token: r.token as string,
  groupId: r.group_id as string,
  memberId: r.member_id as string,
  createdAt: r.created_at as string,
  expiresAt: r.expires_at as string,
});

export function createRepo(db: Db) {
  const q = {
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByToken: db.prepare('SELECT * FROM users WHERE token = ?'),
    insertUser: db.prepare('INSERT INTO users (id, display_name, token) VALUES (?, ?, ?)'),
    groupsForUser: db.prepare(
      `SELECT g.* FROM expense_groups g
       WHERE EXISTS (SELECT 1 FROM members m WHERE m.group_id = g.id AND m.claimed_by_user_id = ?)
       ORDER BY g.created_at DESC`
    ),
    groupById: db.prepare('SELECT * FROM expense_groups WHERE id = ?'),
    renameGroup: db.prepare('UPDATE expense_groups SET name = ? WHERE id = ?'),
    insertGroup: db.prepare('INSERT INTO expense_groups (id, name, currency, created_at) VALUES (?, ?, ?, ?)'),
    isMember: db.prepare('SELECT 1 FROM members WHERE group_id = ? AND claimed_by_user_id = ?'),
    memberForUser: db.prepare('SELECT * FROM members WHERE group_id = ? AND claimed_by_user_id = ?'),
    membersOfGroup: db.prepare('SELECT * FROM members WHERE group_id = ? ORDER BY position'),
    memberById: db.prepare('SELECT * FROM members WHERE id = ?'),
    // group_id is bound twice: once for the row, once for the position subquery.
    appendMember: db.prepare(
      `INSERT INTO members (id, group_id, position, display_name, status, claimed_by_user_id)
       VALUES (?, ?, (SELECT COALESCE(MAX(position) + 1, 0) FROM members WHERE group_id = ?), ?, ?, ?)`
    ),
    setAddress: db.prepare('UPDATE members SET lightning_address = ? WHERE id = ?'),
    // Only ever claims a ghost: the WHERE is what keeps two people off one member.
    // The address a groupmate typed for the ghost goes: a joined member only
    // ever has an address they set themselves (see payout-address).
    claimMember: db.prepare(
      `UPDATE members SET claimed_by_user_id = ?, status = ?, lightning_address = NULL
       WHERE id = ? AND claimed_by_user_id IS NULL`
    ),
    unclaimMember: db.prepare(`UPDATE members SET claimed_by_user_id = NULL, status = 'ghost' WHERE id = ?`),
    unclaimAllOf: db.prepare(`UPDATE members SET claimed_by_user_id = NULL, status = 'ghost' WHERE claimed_by_user_id = ?`),
    claimedCount: db.prepare('SELECT COUNT(*) AS n FROM members WHERE group_id = ? AND claimed_by_user_id IS NOT NULL'),
    deleteMember: db.prepare('DELETE FROM members WHERE id = ?'),
    // Rows that point at a member and so keep it from being deleted. The member id is bound
    // four times: a numbered ?1 is refused by node:sqlite on some of the Node versions we support.
    memberRefs: db.prepare(
      `SELECT (SELECT COUNT(*) FROM settlements WHERE from_member_id = ? OR to_member_id = ?)
            + (SELECT COUNT(*) FROM pay_links WHERE from_member_id = ? OR to_member_id = ?) AS n`
    ),
    expensesOfGroup: db.prepare('SELECT * FROM expenses WHERE group_id = ? ORDER BY created_at'),
    insertExpense: db.prepare(
      `INSERT INTO expenses (id, group_id, description, amount, paid_by_member_id, split_mode, parts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    expenseById: db.prepare('SELECT * FROM expenses WHERE id = ?'),
    updateExpense: db.prepare(
      'UPDATE expenses SET description = ?, amount = ?, paid_by_member_id = ?, split_mode = ?, parts = ? WHERE id = ?'
    ),
    deleteExpense: db.prepare('DELETE FROM expenses WHERE id = ?'),
    insertExpenseChange: db.prepare(
      'INSERT INTO expense_changes (group_id, expense_id, expense, created_at) VALUES (?, ?, ?, ?)'
    ),
    settlementsOfGroup: db.prepare('SELECT * FROM settlements WHERE group_id = ? ORDER BY created_at'),
    settlementById: db.prepare('SELECT * FROM settlements WHERE id = ?'),
    // Finished payments are left out here, so a long history isn't loaded to answer "is anything open?".
    unfinishedToUser: db.prepare(
      `SELECT s.* FROM settlements s JOIN members m ON m.id = s.to_member_id
       WHERE m.claimed_by_user_id = ? AND s.status NOT IN (${TERMINAL_STATUSES.map((st) => `'${st}'`).join(', ')})`
    ),
    insertSettlement: db.prepare(
      `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, amount, currency, rail, status,
                                note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    payLinkByToken: db.prepare('SELECT * FROM pay_links WHERE token = ?'),
    insertPayLink: db.prepare(
      `INSERT INTO pay_links (token, group_id, from_member_id, to_member_id, amount, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ),
    attachToPayLink: db.prepare('UPDATE settlements SET pay_link_token = ? WHERE id = ?'),
    latestForPayLink: db.prepare(
      'SELECT * FROM settlements WHERE pay_link_token = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
    ),
    inviteByToken: db.prepare('SELECT * FROM invites WHERE token = ?'),
    insertInvite: db.prepare(
      `INSERT INTO invites (token, group_id, member_id, created_by_user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ),
    deleteInvitesFor: db.prepare('DELETE FROM invites WHERE member_id = ?'),
    groupLinkByToken: db.prepare('SELECT * FROM group_links WHERE token = ?'),
    groupLinkByGroup: db.prepare('SELECT * FROM group_links WHERE group_id = ?'),
    insertGroupLink: db.prepare('INSERT INTO group_links (token, group_id, created_at) VALUES (?, ?, ?)'),
    deleteGroupLink: db.prepare('DELETE FROM group_links WHERE group_id = ?'),
    // A link that has been paid is spent: opening it shows "Paid" for good and mints nothing.
    payLinkFor: db.prepare(
      `SELECT l.* FROM pay_links l
       WHERE l.group_id = ? AND l.from_member_id = ? AND l.to_member_id = ? AND l.amount = ?
         AND NOT EXISTS (
           SELECT 1 FROM settlements s
           WHERE s.pay_link_token = l.token AND s.status IN (${LEDGER_STATUSES.map((st) => `'${st}'`).join(', ')})
         )
       ORDER BY l.created_at DESC, l.rowid DESC LIMIT 1`
    ),
    firstAccountIn: db.prepare(
      'SELECT claimed_by_user_id AS id FROM members WHERE group_id = ? AND claimed_by_user_id IS NOT NULL ORDER BY position LIMIT 1'
    ),
  };

  // Everything a group owns, in an order the foreign keys allow.
  const dropGroup = [
    'DELETE FROM settlements WHERE group_id = ?',
    'DELETE FROM pay_links WHERE group_id = ?',
    'DELETE FROM invites WHERE group_id = ?',
    'DELETE FROM group_links WHERE group_id = ?',
    'DELETE FROM expenses WHERE group_id = ?',
    'DELETE FROM expense_changes WHERE group_id = ?',
    'DELETE FROM ledger_entries WHERE group_id = ?',
    'DELETE FROM members WHERE group_id = ?',
    'DELETE FROM expense_groups WHERE id = ?',
  ].map((sql) => db.prepare(sql));

  // What an account leaves behind once its members have been handed back.
  const dropUser = [
    'UPDATE settlements SET pay_link_token = NULL WHERE pay_link_token IN (SELECT token FROM pay_links WHERE created_by_user_id = ?)',
    'DELETE FROM pay_links WHERE created_by_user_id = ?',
    'DELETE FROM invites WHERE created_by_user_id = ?',
    'DELETE FROM idempotency_keys WHERE user_id = ?',
    'DELETE FROM users WHERE id = ?',
  ].map((sql) => db.prepare(sql));

  const repo = {
    userById: (id: string) => {
      const r = q.userById.get(id) as Row | undefined;
      return r && toUser(r);
    },
    userByToken: (token: string) => {
      const r = q.userByToken.get(token) as Row | undefined;
      return r && toUser(r);
    },
    insertUser(u: User, token: string): User {
      q.insertUser.run(u.id, u.displayName, token);
      return u;
    },
    /**
     * Removes the account and what only it could use: its pay links, the
     * invites it sent, its saved replies. Its members must already be handed
     * back (unclaimAllOf) and its wallet connection removed (walletStore).
     */
    deleteUser(id: string) {
      for (const stmt of dropUser) stmt.run(id);
    },

    groupsForUser(userId: string): Group[] {
      return (q.groupsForUser.all(userId) as Row[]).map((r) => repo.hydrateGroup(r));
    },

    hydrateGroup(r: Row): Group {
      return {
        id: r.id as string,
        name: r.name as string,
        currency: r.currency as string,
        memberIds: repo.members(r.id as string).map((m) => m.id),
        createdAt: r.created_at as string,
      };
    },

    /**
     * The group, if this user belongs to it. Non-members get not_found rather
     * than forbidden, so a guessed id reveals nothing.
     */
    groupForUser(groupId: string, userId: string): Group {
      const r = q.groupById.get(groupId) as Row | undefined;
      if (!r || !q.isMember.get(groupId, userId)) {
        throw new SattleError('not_found', 'That group doesn’t exist.');
      }
      return repo.hydrateGroup(r);
    },

    /** No membership check. Only for public routes that reach a group through a token. */
    group: (id: string) => {
      const r = q.groupById.get(id) as Row | undefined;
      return r && repo.hydrateGroup(r);
    },

    insertGroup(g: Omit<Group, 'memberIds'>) {
      q.insertGroup.run(g.id, g.name, g.currency, g.createdAt);
    },
    renameGroup(id: string, name: string) {
      q.renameGroup.run(name, id);
    },
    /** The group and everything in it. Its ledger key goes too, so what was mirrored can't be read back from here. */
    deleteGroup(id: string) {
      for (const stmt of dropGroup) stmt.run(id);
    },

    members: (groupId: string) => (q.membersOfGroup.all(groupId) as Row[]).map(toMember),
    /** Adds the member after everyone already in the group. */
    appendMember(m: Omit<Member, 'lightningAddress'>) {
      q.appendMember.run(m.id, m.groupId, m.groupId, m.displayName, m.status, m.claimedByUserId ?? null);
      return repo.member(m.id)!;
    },
    member: (id: string) => {
      const r = q.memberById.get(id) as Row | undefined;
      return r && toMember(r);
    },
    setMemberAddress(id: string, address: string) {
      q.setAddress.run(address, id);
      return repo.member(id)!;
    },
    /** The member this user is in the group, if they're in it. */
    memberForUser: (groupId: string, userId: string) => {
      const r = q.memberForUser.get(groupId, userId) as Row | undefined;
      return r && toMember(r);
    },
    /** Hands a ghost to a user. False if someone already has it. */
    claimMember(id: string, userId: string, status: Exclude<Member['status'], 'ghost'>): boolean {
      return q.claimMember.run(userId, status, id).changes === 1;
    },
    /** The reverse: the member is a ghost again, with its name, history and balance. An invite can hand it back. */
    unclaimMember(id: string) {
      q.unclaimMember.run(id);
    },
    /** Every member the user holds, in every group. */
    unclaimAllOf(userId: string) {
      q.unclaimAllOf.run(userId);
    },
    /** How many people with an account are in the group. */
    claimedCount: (groupId: string) => (q.claimedCount.get(groupId) as { n: number }).n,
    /** In an expense, a payment or a pay link. Such a member can't be deleted without rewriting the ledger. */
    memberHasHistory(groupId: string, memberId: string): boolean {
      if ((q.memberRefs.get(memberId, memberId, memberId, memberId) as { n: number }).n > 0) return true;
      return repo
        .expenses(groupId)
        .some((e) => e.paidByMemberId === memberId || e.parts.some((p) => p.memberId === memberId));
    },
    /** Only for a member with no history. Invites sent for them go too. */
    deleteMember(id: string) {
      q.deleteInvitesFor.run(id);
      q.deleteMember.run(id);
    },

    expenses: (groupId: string) => (q.expensesOfGroup.all(groupId) as Row[]).map(toExpense),
    insertExpense(e: Expense) {
      q.insertExpense.run(e.id, e.groupId, e.description, e.amount, e.paidByMemberId, e.splitMode, JSON.stringify(e.parts), e.createdAt);
      return e;
    },
    expense: (id: string) => {
      const r = q.expenseById.get(id) as Row | undefined;
      return r && toExpense(r);
    },
    /** Replaces what the expense says, and notes the change for the ledger on Nostr. */
    updateExpense(e: Expense) {
      q.updateExpense.run(e.description, e.amount, e.paidByMemberId, e.splitMode, JSON.stringify(e.parts), e.id);
      q.insertExpenseChange.run(e.groupId, e.id, JSON.stringify(e), nowIso());
      return e;
    },
    /** Removes the expense, and notes that for the ledger on Nostr. */
    deleteExpense(e: Expense) {
      q.deleteExpense.run(e.id);
      q.insertExpenseChange.run(e.groupId, e.id, null, nowIso());
    },

    settlements: (groupId: string) => (q.settlementsOfGroup.all(groupId) as Row[]).map(toSettlement),
    settlement: (id: string) => {
      const r = q.settlementById.get(id) as Row | undefined;
      return r && toSettlement(r);
    },
    /**
     * Payments that haven't reached an end state, whose payee is a member this
     * user holds, in any group. Not all of them are still open: an invoice
     * whose quote has lapsed is in here too (isInProgress tells them apart).
     */
    unfinishedToUser: (userId: string) => (q.unfinishedToUser.all(userId) as Row[]).map(toSettlement),
    insertSettlement(s: Settlement) {
      q.insertSettlement.run(
        s.id, s.groupId, s.fromMemberId, s.toMemberId, s.amount, s.currency, s.rail, s.status,
        s.note ?? null, s.createdAt, s.updatedAt
      );
      return s;
    },

    updateSettlement(
      id: string,
      patch: Partial<Pick<Settlement, 'status' | 'quote' | 'destination' | 'preimage' | 'failureReason'>>
    ): Settlement {
      const cols: Record<string, unknown> = {};
      if (patch.status !== undefined) cols.status = patch.status;
      if (patch.quote !== undefined) cols.quote = JSON.stringify(patch.quote);
      if (patch.destination !== undefined) cols.destination = patch.destination;
      if (patch.preimage !== undefined) cols.preimage = patch.preimage;
      if (patch.failureReason !== undefined) cols.failure_reason = patch.failureReason;
      cols.updated_at = nowIso();
      const keys = Object.keys(cols);
      db.prepare(`UPDATE settlements SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
        ...(keys.map((k) => cols[k]) as (string | number | null)[]),
        id
      );
      return repo.settlement(id)!;
    },

    payLink: (token: string) => {
      const r = q.payLinkByToken.get(token) as Row | undefined;
      return r && toPayLink(r);
    },
    insertPayLink(link: PayLink, createdByUserId: string) {
      q.insertPayLink.run(
        link.token, link.groupId, link.fromMemberId, link.toMemberId, link.amount, createdByUserId, link.createdAt
      );
      return link;
    },
    /** Records that this settlement came from opening the link. */
    attachToPayLink(settlementId: string, token: string) {
      q.attachToPayLink.run(token, settlementId);
    },
    /** The settlement the link opened most recently, whatever its status. */
    latestForPayLink: (token: string) => {
      const r = q.latestForPayLink.get(token) as Row | undefined;
      return r && toSettlement(r);
    },

    /**
     * The newest pay link for exactly this debt and amount that can still be
     * paid, whoever made it. One that was already paid doesn't count: the same
     * two people can owe the same amount again, and that is a new debt.
     */
    payLinkFor: (d: Pick<Debt, 'groupId' | 'fromMemberId' | 'toMemberId' | 'amount'>) => {
      const r = q.payLinkFor.get(d.groupId, d.fromMemberId, d.toMemberId, d.amount) as Row | undefined;
      return r && toPayLink(r);
    },

    groupLink: (token: string) => {
      const r = q.groupLinkByToken.get(token) as Row | undefined;
      return r && toGroupLink(r);
    },
    groupLinkFor: (groupId: string) => {
      const r = q.groupLinkByGroup.get(groupId) as Row | undefined;
      return r && toGroupLink(r);
    },
    /** A group has one link at a time: this one takes the place of any before it. */
    replaceGroupLink(link: GroupLink) {
      q.deleteGroupLink.run(link.groupId);
      q.insertGroupLink.run(link.token, link.groupId, link.createdAt);
      return link;
    },
    deleteGroupLink(groupId: string) {
      q.deleteGroupLink.run(groupId);
    },
    /** The account of the first member who has one. Every group has at least one. */
    firstAccountIn: (groupId: string) => (q.firstAccountIn.get(groupId) as { id: string } | undefined)?.id,

    /** The invite, and who made it. */
    invite: (token: string) => {
      const r = q.inviteByToken.get(token) as Row | undefined;
      return r && { ...toInvite(r), createdByUserId: r.created_by_user_id as string };
    },
    /** Replaces any earlier invite for the same member, so only the newest link works. */
    insertInvite(invite: Invite, createdByUserId: string) {
      q.deleteInvitesFor.run(invite.memberId);
      q.insertInvite.run(invite.token, invite.groupId, invite.memberId, createdByUserId, invite.createdAt, invite.expiresAt);
      return invite;
    },
  };

  return repo;
}

export type Repo = ReturnType<typeof createRepo>;
