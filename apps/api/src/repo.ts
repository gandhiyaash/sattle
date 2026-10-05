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
  type JoinRequest,
  type Member,
  type PayLink,
  type Settlement,
  type UpiClaim,
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

const toUpiClaim = (r: Row): UpiClaim => ({
  id: r.id as string,
  groupId: r.group_id as string,
  fromMemberId: r.from_member_id as string,
  toMemberId: r.to_member_id as string,
  amount: r.amount as number,
  reference: opt(r.reference),
  status: r.status as UpiClaim['status'],
  ...(r.via_link ? { viaLink: true } : {}),
  createdAt: r.created_at as string,
});

/** A request to join, with what only the server needs: who asked, and which member they'd be. */
export interface StoredJoinRequest extends Omit<JoinRequest, 'groupName' | 'name'> {
  groupId: string;
  userId: string;
  memberId?: string;
  displayName: string;
  /** Who has the name they asked for, when someone had joined as it: letting them in takes it from that account. */
  replacesUserId?: string;
}

const toJoinRequest = (r: Row): StoredJoinRequest => ({
  id: r.id as string,
  groupId: r.group_id as string,
  userId: r.user_id as string,
  memberId: opt(r.member_id),
  displayName: r.display_name as string,
  replacesUserId: opt(r.replaces_user_id),
  code: r.code as string,
  status: r.status as JoinRequest['status'],
  createdAt: r.created_at as string,
});

/** How long a replaced sign-in key can still fetch the answer it missed. Long enough for a retry, no longer. */
export const PREVIOUS_TOKEN_MS = 10 * 60_000;

export function createRepo(db: Db) {
  const q = {
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByToken: db.prepare('SELECT * FROM users WHERE token = ?'),
    userByPreviousToken: db.prepare('SELECT * FROM users WHERE previous_token = ? AND previous_token_until > ?'),
    replaceToken: db.prepare(
      'UPDATE users SET previous_token = token, previous_token_until = ?, token = ? WHERE id = ?'
    ),
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
    // What they chose about this group's shared link (upi_on_link) was theirs, so it goes with them.
    unclaimMember: db.prepare(
      `UPDATE members SET claimed_by_user_id = NULL, status = 'ghost', upi_on_link = NULL WHERE id = ?`
    ),
    unclaimAllOf: db.prepare(
      `UPDATE members SET claimed_by_user_id = NULL, status = 'ghost', upi_on_link = NULL WHERE claimed_by_user_id = ?`
    ),
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
    settlementByPaymentHash: db.prepare('SELECT * FROM settlements WHERE payment_hash = ?'),
    paymentHashOf: db.prepare('SELECT payment_hash, pay_link_token FROM settlements WHERE id = ?'),
    // Any open or closed-unpaid row: a proof can confirm an invoice we'd
    // already called expired, since it may have been paid late.
    confirmWithProof: db.prepare(
      `UPDATE settlements SET status = 'confirmed', preimage = ?, failure_reason = NULL, updated_at = ?
       WHERE id = ? AND status NOT IN ('confirmed', 'manually_confirmed')`
    ),
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
    groupLinkByToken: db.prepare('SELECT * FROM group_links WHERE token = ?'),
    groupLinkByGroup: db.prepare('SELECT * FROM group_links WHERE group_id = ?'),
    insertGroupLink: db.prepare('INSERT INTO group_links (token, group_id, created_at) VALUES (?, ?, ?)'),
    deleteGroupLink: db.prepare('DELETE FROM group_links WHERE group_id = ?'),
    upiClaimById: db.prepare('SELECT * FROM upi_claims WHERE id = ?'),
    upiClaimsOfGroup: db.prepare('SELECT * FROM upi_claims WHERE group_id = ? ORDER BY created_at'),
    insertUpiClaim: db.prepare(
      `INSERT INTO upi_claims (id, group_id, from_member_id, to_member_id, amount, reference, status, via_link, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    setUpiClaimStatus: db.prepare('UPDATE upi_claims SET status = ? WHERE id = ?'),
    deleteUpiClaim: db.prepare('DELETE FROM upi_claims WHERE id = ?'),
    deleteUpiClaimForPair: db.prepare(
      'DELETE FROM upi_claims WHERE group_id = ? AND from_member_id = ? AND to_member_id = ?'
    ),
    joinRequestById: db.prepare('SELECT * FROM join_requests WHERE id = ?'),
    joinRequestsOfGroup: db.prepare(
      `SELECT * FROM join_requests WHERE group_id = ? AND status = 'pending' ORDER BY created_at, rowid`
    ),
    joinRequestsOfUser: db.prepare('SELECT * FROM join_requests WHERE user_id = ? ORDER BY created_at, rowid'),
    pendingJoinCount: db.prepare(`SELECT COUNT(*) AS n FROM join_requests WHERE group_id = ? AND status = 'pending'`),
    // One per person per group: asking again replaces the last, whatever became of it.
    upsertJoinRequest: db.prepare(
      `INSERT INTO join_requests (id, group_id, user_id, member_id, display_name, code, status, created_at, replaces_user_id)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT (group_id, user_id) DO UPDATE SET id = excluded.id, member_id = excluded.member_id,
         display_name = excluded.display_name, code = excluded.code, status = 'pending', created_at = excluded.created_at,
         replaces_user_id = excluded.replaces_user_id`
    ),
    setJoinRequestStatus: db.prepare('UPDATE join_requests SET status = ? WHERE id = ?'),
    deleteJoinRequest: db.prepare('DELETE FROM join_requests WHERE id = ?'),
    // Everyone else asking to be a member who has just been let in, or removed, can't be them now.
    declineJoinRequestsFor: db.prepare(
      `UPDATE join_requests SET status = 'declined', member_id = NULL, replaces_user_id = NULL WHERE member_id = ?`
    ),
    deleteUpiClaimsOfMember: db.prepare('DELETE FROM upi_claims WHERE from_member_id = ? OR to_member_id = ?'),
    deleteUpiClaimsOfUser: db.prepare(
      `DELETE FROM upi_claims
       WHERE from_member_id IN (SELECT id FROM members WHERE claimed_by_user_id = ?)
          OR to_member_id IN (SELECT id FROM members WHERE claimed_by_user_id = ?)`
    ),
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
    'DELETE FROM group_links WHERE group_id = ?',
    'DELETE FROM upi_claims WHERE group_id = ?',
    'DELETE FROM join_requests WHERE group_id = ?',
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
    'DELETE FROM join_requests WHERE user_id = ?',
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
    /** The account whose sign-in key this was until it was replaced, in the last few minutes. Only good for replaying that replacement. */
    userByPreviousToken: (token: string) => {
      const r = q.userByPreviousToken.get(token, nowIso()) as Row | undefined;
      return r && toUser(r);
    },
    insertUser(u: User, token: string): User {
      q.insertUser.run(u.id, u.displayName, token);
      return u;
    },
    /** A new sign-in key. The old one stops working; it is kept a few minutes only so a lost answer can be replayed. */
    replaceToken(userId: string, token: string) {
      q.replaceToken.run(new Date(Date.now() + PREVIOUS_TOKEN_MS).toISOString(), token, userId);
    },
    /**
     * Removes the account and what only it could use: its pay links, its
     * requests to join, its saved replies. Its members must already be handed
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
    /**
     * Hands a member from the account that has it to another, as if the first
     * left and the second was let in as the ghost. False, and nothing changes,
     * if `fromUserId` no longer has it.
     */
    handOverMember(id: string, fromUserId: string, toUserId: string, status: Exclude<Member['status'], 'ghost'>): boolean {
      if (repo.member(id)?.claimedByUserId !== fromUserId) return false;
      repo.unclaimMember(id);
      return repo.claimMember(id, toUserId, status);
    },
    /** The reverse: the member is a ghost again, with its name, history and balance. The group's link can hand it back. */
    unclaimMember(id: string) {
      // A UPI claim is between two people with accounts: one made it, the other confirms it.
      q.deleteUpiClaimsOfMember.run(id, id);
      q.unclaimMember.run(id);
    },
    /** Every member the user holds, in every group. */
    unclaimAllOf(userId: string) {
      q.deleteUpiClaimsOfUser.run(userId, userId);
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
    /** Only for a member with no history. */
    deleteMember(id: string) {
      q.deleteUpiClaimsOfMember.run(id, id);
      q.declineJoinRequestsFor.run(id);
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
    /** Server-side invoice details the Settlement type leaves out. */
    invoiceOf(id: string) {
      const r = q.paymentHashOf.get(id) as { payment_hash: string | null; pay_link_token: string | null } | undefined;
      return r && { paymentHash: opt<string>(r.payment_hash), payLinkToken: opt<string>(r.pay_link_token) };
    },
    settlementByPaymentHash: (hash: string) => {
      const r = q.settlementByPaymentHash.get(hash) as Row | undefined;
      return r && toSettlement(r);
    },
    /** Confirms with a checked preimage. False if it was already confirmed. */
    confirmWithProof(id: string, preimage: string) {
      return q.confirmWithProof.run(preimage, nowIso(), id).changes === 1;
    },

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

    /** A payer's word that they paid over UPI, waiting on the person owed. */
    upiClaim: (id: string) => {
      const r = q.upiClaimById.get(id) as Row | undefined;
      return r && toUpiClaim(r);
    },
    upiClaims: (groupId: string) => (q.upiClaimsOfGroup.all(groupId) as Row[]).map(toUpiClaim),
    /** One per pair: the new claim takes the place of the last, whether it was pending or declined. */
    replaceUpiClaim(claim: UpiClaim) {
      q.deleteUpiClaimForPair.run(claim.groupId, claim.fromMemberId, claim.toMemberId);
      q.insertUpiClaim.run(
        claim.id, claim.groupId, claim.fromMemberId, claim.toMemberId, claim.amount,
        claim.reference ?? null, claim.status, claim.viaLink ? 1 : 0, claim.createdAt
      );
      return claim;
    },
    setUpiClaimStatus(id: string, status: UpiClaim['status']) {
      q.setUpiClaimStatus.run(status, id);
      return repo.upiClaim(id)!;
    },
    deleteUpiClaim(id: string) {
      q.deleteUpiClaim.run(id);
    },

    joinRequest: (id: string) => {
      const r = q.joinRequestById.get(id) as Row | undefined;
      return r && toJoinRequest(r);
    },
    /** The requests waiting on someone in the group, oldest first. */
    pendingJoins: (groupId: string) => (q.joinRequestsOfGroup.all(groupId) as Row[]).map(toJoinRequest),
    pendingJoinCount: (groupId: string) => (q.pendingJoinCount.get(groupId) as { n: number }).n,
    /** Everything this user has asked to join, waiting or turned down. */
    joinRequestsOf: (userId: string) => (q.joinRequestsOfUser.all(userId) as Row[]).map(toJoinRequest),
    /** Takes the place of the user's last request for this group. */
    putJoinRequest(r: Omit<StoredJoinRequest, 'status'>) {
      q.upsertJoinRequest.run(
        r.id,
        r.groupId,
        r.userId,
        r.memberId ?? null,
        r.displayName,
        r.code,
        r.createdAt,
        r.replacesUserId ?? null
      );
      return repo.joinRequest(r.id)!;
    },
    declineJoinRequest(id: string) {
      q.setJoinRequestStatus.run('declined', id);
    },
    deleteJoinRequest(id: string) {
      q.deleteJoinRequest.run(id);
    },
    /** Turns down everyone else asking to be this member: someone has just been let in as them. */
    declineJoinRequestsFor(memberId: string) {
      q.declineJoinRequestsFor.run(memberId);
    },
  };

  return repo;
}

export type Repo = ReturnType<typeof createRepo>;
