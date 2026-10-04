import { Hono } from 'hono';
import { z } from 'zod';

import { SattleError, parseLightningAddress, resolveParts, type Expense } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { transaction } from '../db';
import { minor, parse } from '../http';
import { idempotency } from '../middleware';
import { newId, nowIso } from '../repo';
import { debtsOf } from '../settlementRules';

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
  // when the app formats one of the group's amounts.
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'expected a three-letter currency code like INR')
    .default('INR'),
  memberNames: z.array(z.string().trim().min(1).max(40)).max(50),
});

export const AddMemberBody = z.object({ displayName: z.string().trim().min(1).max(40) });

const AddressBody = z.object({ address: z.string() });

export function groupRoutes({ db, repo, wallets }: Ctx) {
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

  r.get('/groups/:id/members', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    return c.json(repo.members(g.id));
  });

  /** Appends a ghost after the existing members. */
  r.post('/groups/:id/members', once, async (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    const { displayName } = parse(AddMemberBody, await c.req.json());
    return c.json(repo.appendMember({ id: newId('m'), groupId: g.id, displayName, status: 'ghost' }), 201);
  });

  r.get('/groups/:id/expenses', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    return c.json(repo.expenses(g.id));
  });

  r.post('/groups/:id/expenses', once, async (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    const body = parse(ExpenseBody, await c.req.json(), 'invalid_expense');

    const bad = [body.paidByMemberId, ...body.parts.map((p) => p.memberId)].find(
      (id) => !g.memberIds.includes(id)
    );
    if (bad) throw new SattleError('invalid_expense', 'Someone in that split isn’t in this group.');

    const input = { ...body, groupId: g.id };
    const expense: Expense = {
      id: newId('e'),
      ...input,
      parts: resolveParts(input),
      createdAt: nowIso(),
    };
    return c.json(repo.insertExpense(expense), 201);
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
