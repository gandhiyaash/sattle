import { Hono } from 'hono';
import { z } from 'zod';

import { SattleError, parseLightningAddress, resolveParts, type Expense } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { minor, notImplemented, parse } from '../http';
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
  currency: z.string().length(3).default('INR'),
  memberNames: z.array(z.string().trim().min(1).max(40)).max(50),
});

export const AddMemberBody = z.object({ displayName: z.string().trim().min(1).max(40) });

const AddressBody = z.object({ address: z.string() });

export function groupRoutes({ db, repo }: Ctx) {
  const r = new Hono<AppEnv>();
  const once = idempotency(db);

  r.get('/me', (c) => c.json(c.get('user')));

  r.get('/groups', (c) => c.json(repo.groupsForUser(c.get('user').id)));

  r.post('/groups', once, async (c) => {
    parse(CreateGroupBody, await c.req.json());
    // The creator becomes member 0, `joined` and claimed by them; everyone in
    // memberNames is a ghost. Returns 201 with the Group.
    return notImplemented('Creating groups');
  });

  r.get('/groups/:id', (c) => c.json(repo.groupForUser(c.req.param('id'), c.get('user').id)));

  r.get('/groups/:id/members', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    return c.json(repo.members(g.id));
  });

  r.post('/groups/:id/members', once, async (c) => {
    repo.groupForUser(c.req.param('id'), c.get('user').id);
    parse(AddMemberBody, await c.req.json());
    // Appends a ghost at the next position. Returns 201 with the Member.
    return notImplemented('Adding members');
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
    repo.groupForUser(member.groupId, c.get('user').id);

    const { address } = parse(AddressBody, await c.req.json(), 'invalid_address');
    const parsed = parseLightningAddress(address);
    if (!parsed.ok) throw new SattleError('invalid_address', parsed.reason);
    // Status stays as-is: a ghost with an address is payable, not joined.
    return c.json(repo.setMemberAddress(member.id, parsed.address));
  });

  return r;
}
