/**
 * Row ↔ domain mapping. Everything that leaves this file is a domain type
 * from @sattle/core, so routes never see snake_case or NULLs.
 */

import { randomUUID } from 'node:crypto';

import {
  SattleError,
  type Expense,
  type Group,
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

export function createRepo(db: Db) {
  const q = {
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByToken: db.prepare('SELECT * FROM users WHERE token = ?'),
    groupsForUser: db.prepare(
      `SELECT g.* FROM expense_groups g
       WHERE EXISTS (SELECT 1 FROM members m WHERE m.group_id = g.id AND m.claimed_by_user_id = ?)
       ORDER BY g.created_at DESC`
    ),
    groupById: db.prepare('SELECT * FROM expense_groups WHERE id = ?'),
    isMember: db.prepare('SELECT 1 FROM members WHERE group_id = ? AND claimed_by_user_id = ?'),
    membersOfGroup: db.prepare('SELECT * FROM members WHERE group_id = ? ORDER BY position'),
    memberById: db.prepare('SELECT * FROM members WHERE id = ?'),
    setAddress: db.prepare('UPDATE members SET lightning_address = ? WHERE id = ?'),
    expensesOfGroup: db.prepare('SELECT * FROM expenses WHERE group_id = ? ORDER BY created_at'),
    insertExpense: db.prepare(
      `INSERT INTO expenses (id, group_id, description, amount, paid_by_member_id, split_mode, parts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    settlementsOfGroup: db.prepare('SELECT * FROM settlements WHERE group_id = ? ORDER BY created_at'),
    settlementById: db.prepare('SELECT * FROM settlements WHERE id = ?'),
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
  };

  const repo = {
    userById: (id: string) => {
      const r = q.userById.get(id) as Row | undefined;
      return r && toUser(r);
    },
    userByToken: (token: string) => {
      const r = q.userByToken.get(token) as Row | undefined;
      return r && toUser(r);
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

    members: (groupId: string) => (q.membersOfGroup.all(groupId) as Row[]).map(toMember),
    member: (id: string) => {
      const r = q.memberById.get(id) as Row | undefined;
      return r && toMember(r);
    },
    setMemberAddress(id: string, address: string) {
      q.setAddress.run(address, id);
      return repo.member(id)!;
    },

    expenses: (groupId: string) => (q.expensesOfGroup.all(groupId) as Row[]).map(toExpense),
    insertExpense(e: Expense) {
      q.insertExpense.run(e.id, e.groupId, e.description, e.amount, e.paidByMemberId, e.splitMode, JSON.stringify(e.parts), e.createdAt);
      return e;
    },

    settlements: (groupId: string) => (q.settlementsOfGroup.all(groupId) as Row[]).map(toSettlement),
    settlement: (id: string) => {
      const r = q.settlementById.get(id) as Row | undefined;
      return r && toSettlement(r);
    },
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
  };

  return repo;
}

export type Repo = ReturnType<typeof createRepo>;
