import { Hono } from 'hono';
import { z } from 'zod';

import { SattleError, parseLightningAddress, resolveParts, sameExpense, type Expense, type Group } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { transaction } from '../db';
import { minor, parse } from '../http';
import { idempotency } from '../middleware';
import { receivable } from '../payments';
import { newId, nowIso } from '../repo';
import { checkExpenseOwner, checkGroupCanGo, checkMemberCanGo, leaveGroup } from '../groupRules';
import { debtsOf } from '../settlementRules';
import { takesUpi } from './upi';

const ExpenseBody = z.object({
  description: z.string().trim().min(1).max(200),
  amount: minor,
  paidByMemberId: z.string(),
  splitMode: z.enum(['equal', 'shares', 'exact']),
  parts: z
    .array(
      z.object({
        memberId: z.string(),
        weight: z.number().positive().optional(),
        amount: z.number().int().nonnegative().optional(),
      })
    )
    .min(1),
});

export const CreateGroupBody = z.object({
  name: z.string().trim().min(1).max(80),
  // Shaped like an ISO 4217 code. Anything else makes Intl.NumberFormat throw
  // when the app formats one of the group's amounts. BTC is a group counted
  // in sats: its amounts are whole sats, and settling it needs no rate.
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'expected a three-letter currency code like INR')
    .default('INR'),
  memberNames: z.array(z.string().trim().min(1).max(40)).max(50),
});

export const AddMemberBody = z.object({ displayName: z.string().trim().min(1).max(40) });

export const RenameGroupBody = CreateGroupBody.pick({ name: true });

const AddressBody = z.object({ address: z.string() });

export function groupRoutes({ db, repo, wallets, payments }: Ctx) {
  const r = new Hono<AppEnv>();
  const once = idempotency(db);

  r.get('/me', (c) => c.json(c.get('user')));

  r.get('/groups', (c) => c.json(repo.groupsForUser(c.get('user').id)));

  /**
   * The creator becomes member 0, claimed by them; everyone in memberNames is
   * a ghost. The creator is `joined`, or `nwc_linked` if they already
   * connected a wallet, like the members they have in other groups.
   */
  r.post('/groups', once, async (c) => {
    const user = c.get('user');
    const body = parse(CreateGroupBody, await c.req.json());
    const groupId = newId('g');
    const creatorStatus = wallets.connection(user.id).connected ? 'nwc_linked' : 'joined';

    transaction(db, () => {
      repo.insertGroup({ id: groupId, name: body.name, currency: body.currency, createdAt: nowIso() });
      repo.appendMember({ id: newId('m'), groupId, displayName: user.displayName, status: creatorStatus, claimedByUserId: user.id });
      for (const displayName of body.memberNames) {
        repo.appendMember({ id: newId('m'), groupId, displayName, status: 'ghost' });
      }
    });
    return c.json(repo.groupForUser(groupId, user.id), 201);
  });

  r.get('/groups/:id', (c) => c.json(repo.groupForUser(c.req.param('id'), c.get('user').id)));

  /** Anyone in the group can rename it. Returns the Group. */
  r.put('/groups/:id', once, async (c) => {
    const user = c.get('user');
    const g = repo.groupForUser(c.req.param('id'), user.id);
    const { name } = parse(RenameGroupBody, await c.req.json());
    repo.renameGroup(g.id, name);
    return c.json(repo.groupForUser(g.id, user.id));
  });

  /**
   * Deletes the group and everything in it, for everyone. Anyone in it can,
   * but only once nothing is owed and no payment is under way (409 conflict
   * otherwise), so deleting a group can't erase what someone is owed.
   */
  r.delete('/groups/:id', once, (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    transaction(db, () => {
      checkGroupCanGo(repo, g);
      repo.deleteGroup(g.id);
    });
    return c.json({ ok: true });
  });

  /**
   * The caller's member becomes a ghost again and they lose the group. Their
   * name, history and balance stay; the group's link can bring them back. 409 for
   * the only person with an account, or while a payment to them is under way.
   */
  r.post('/groups/:id/leave', once, (c) => {
    const user = c.get('user');
    const g = repo.groupForUser(c.req.param('id'), user.id);
    transaction(db, () => leaveGroup(repo, g, user.id));
    return c.json({ ok: true });
  });

  r.get('/groups/:id/members', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    // With whether each can be paid now, which only the server can tell under real payments,
    // and whether they take UPI. The UPI ID itself is only for someone who owes them.
    return c.json(
      repo.members(g.id).map((m) => ({
        ...m,
        receivable: receivable(payments, m),
        ...(takesUpi(wallets, m) ? { upi: true } : {}),
      }))
    );
  });

  /** Appends a ghost after the existing members. */
  r.post('/groups/:id/members', once, async (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    const { displayName } = parse(AddMemberBody, await c.req.json());
    return c.json(repo.appendMember({ id: newId('m'), groupId: g.id, displayName, status: 'ghost' }), 201);
  });

  /**
   * Removes someone added by mistake: a ghost that no expense, payment or
   * pay link names. Anyone else is part of the ledger and stays (409), and
   * someone who has joined can only take themselves out (400).
   */
  r.delete('/groups/:id/members/:memberId', once, (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    transaction(db, () => {
      const member = repo.member(c.req.param('memberId'));
      if (!member || member.groupId !== g.id) throw new SattleError('not_found', 'That member isn’t in this group.');
      checkMemberCanGo(repo, g, member);
      repo.deleteMember(member.id);
    });
    return c.json({ ok: true });
  });

  r.get('/groups/:id/expenses', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    return c.json(repo.expenses(g.id));
  });

  /** The body of an expense, checked against the group. */
  const readExpense = (g: Group, json: unknown) => {
    const body = parse(ExpenseBody, json, 'invalid_expense');
    const bad = [body.paidByMemberId, ...body.parts.map((p) => p.memberId)].find(
      (id) => !g.memberIds.includes(id)
    );
    if (bad) throw new SattleError('invalid_expense', 'Someone in that split isn’t in this group.');
    return { ...body, groupId: g.id };
  };

  const findExpense = (g: Group, id: string) => {
    const expense = repo.expense(id);
    if (!expense || expense.groupId !== g.id) throw new SattleError('not_found', 'That expense doesn’t exist.');
    return expense;
  };

  r.post('/groups/:id/expenses', once, async (c) => {
    const user = c.get('user');
    const g = repo.groupForUser(c.req.param('id'), user.id);
    const input = readExpense(g, await c.req.json());
    const expense: Expense = {
      id: newId('e'),
      ...input,
      parts: resolveParts(input, g.currency),
      createdAt: nowIso(),
      addedByMemberId: repo.memberForUser(g.id, user.id)!.id,
    };
    return c.json(repo.insertExpense(expense), 201);
  });

  /**
   * Replaces what an expense says: what it was, how much, who paid, who it's
   * split between. Only the person who paid may (400 invalid_input for anyone
   * else), since it's their money the expense says is owed back; what a ghost
   * paid, anyone in the group may change. Returns the Expense. Saving one as
   * it already stood changes nothing, so nothing is noted for it.
   */
  r.put('/groups/:id/expenses/:expenseId', once, async (c) => {
    const user = c.get('user');
    const g = repo.groupForUser(c.req.param('id'), user.id);
    const input = readExpense(g, await c.req.json());

    const expense = transaction(db, () => {
      const current = findExpense(g, c.req.param('expenseId'));
      checkExpenseOwner(repo, current, user.id);
      const next = { ...current, ...input, parts: resolveParts(input, g.currency) };
      if (sameExpense(current, next)) return current;
      return repo.updateExpense(next, current, repo.memberForUser(g.id, user.id)!.id);
    });
    return c.json(expense);
  });

  /** Removes an expense. Same rule as changing it. */
  r.delete('/groups/:id/expenses/:expenseId', once, (c) => {
    const user = c.get('user');
    const g = repo.groupForUser(c.req.param('id'), user.id);
    transaction(db, () => {
      const current = findExpense(g, c.req.param('expenseId'));
      checkExpenseOwner(repo, current, user.id);
      repo.deleteExpense(current, repo.memberForUser(g.id, user.id)!.id);
    });
    return c.json({ ok: true });
  });

  r.get('/groups/:id/debts', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    return c.json(debtsOf(repo, g));
  });

  r.put('/members/:id/payout-address', async (c) => {
    const member = repo.member(c.req.param('id'));
    if (!member) throw new SattleError('not_found', 'That member doesn’t exist.');
    const user = c.get('user');
    repo.groupForUser(member.groupId, user.id);
    // Anyone in the group can give a ghost an address; someone who has joined
    // sets their own, or a groupmate could redirect what they're paid. Joining
    // clears the address a groupmate typed, so a joined member's address is
    // always one they chose. A payment proven to it is a payment to them.
    if (member.claimedByUserId && member.claimedByUserId !== user.id) {
      throw new SattleError('invalid_input', `Only ${member.displayName} can change where they get paid.`);
    }

    const { address } = parse(AddressBody, await c.req.json(), 'invalid_address');
    const parsed = parseLightningAddress(address);
    if (!parsed.ok) throw new SattleError('invalid_address', parsed.reason);
    // Status stays as-is: a ghost with an address is payable, not joined.
    return c.json(repo.setMemberAddress(member.id, parsed.address));
  });

  return r;
}
