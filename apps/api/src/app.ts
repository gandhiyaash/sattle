/**
 * HTTP routes. The contract is apps/mobile/src/client/ApiClient.ts — one
 * method there, one route here, same shapes.
 *
 * Rules enforced here, not trusted from the client:
 * - you only see groups you're a member of (others 404)
 * - ghosts with no address can't receive (409 member_cannot_receive)
 * - a settlement can't exceed what's actually owed right now
 * - a second payment can't start while one is already in progress
 * - idempotency-key replays the first response instead of acting twice
 */

import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';

import {
  SattleError,
  TERMINAL_STATUSES,
  canReceive,
  computeBalances,
  parseLightningAddress,
  resolveParts,
  simplifyDebts,
  type Expense,
  type Group,
  type Settlement,
  type SattleErrorCode,
  type User,
} from '@sattle/core';

import { transaction, type Db } from './db';
import type { PaymentBackend } from './payments';
import { createRepo, newId, nowIso, type Repo } from './repo';

type Env = { Variables: { user: User } };

export interface AppDeps {
  db: Db;
  payments: (repo: Repo) => PaymentBackend;
  /** Acts as this user when no bearer token is sent. Dev only — unset in production. */
  demoUserId?: string;
  corsOrigin?: string | string[];
}

const STATUS: Record<SattleErrorCode, 400 | 401 | 404 | 409 | 500 | 502 | 503> = {
  not_found: 404,
  invalid_expense: 400,
  invalid_address: 400,
  member_cannot_receive: 409,
  conflict: 409,
  unauthorized: 401,
  payment_failed: 502,
  network: 503,
  internal: 500,
};

// -- request bodies --------------------------------------------------------

const minor = z.number().int().positive();

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

const SettlementBody = z.object({
  fromMemberId: z.string(),
  toMemberId: z.string(),
  amount: minor,
  rail: z.enum(['in_app', 'lightning_address', 'invoice', 'manual']),
});

const ManualBody = SettlementBody.omit({ rail: true }).extend({
  note: z.string().trim().max(200).optional(),
});

const AddressBody = z.object({ address: z.string() });

function parse<T>(schema: z.ZodType<T>, body: unknown, code: SattleErrorCode = 'invalid_expense'): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new SattleError(code, `${issue.path.join('.') || 'body'}: ${issue.message}`);
  }
  return r.data;
}

// -- app -------------------------------------------------------------------

export function createApp(deps: AppDeps) {
  const { db } = deps;
  const repo = createRepo(db);
  const payments = deps.payments(repo);
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof SattleError) {
      return c.json({ code: err.code, message: err.message }, STATUS[err.code] ?? 400);
    }
    if (err instanceof SyntaxError) {
      return c.json({ code: 'invalid_expense', message: 'Request body isn’t valid JSON.' }, 400);
    }
    console.error(err);
    return c.json({ code: 'internal', message: 'Something went wrong on our side.' }, 500);
  });

  app.notFound((c) => c.json({ code: 'not_found', message: 'No such route.' }, 404));

  app.use(
    '*',
    cors({
      origin: deps.corsOrigin ?? '*',
      allowHeaders: ['authorization', 'content-type', 'idempotency-key'],
      allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    })
  );

  app.get('/health', (c) => c.json({ ok: true }));

  app.use('*', auth(repo, deps.demoUserId));

  // -- reads ---------------------------------------------------------------

  app.get('/me', (c) => c.json(c.get('user')));

  app.get('/groups', (c) => c.json(repo.groupsForUser(c.get('user').id)));

  app.get('/groups/:id', (c) => c.json(repo.groupForUser(c.req.param('id'), c.get('user').id)));

  app.get('/groups/:id/members', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    return c.json(repo.members(g.id));
  });

  app.get('/groups/:id/expenses', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    return c.json(repo.expenses(g.id));
  });

  app.get('/groups/:id/debts', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    return c.json(debtsOf(repo, g));
  });

  app.get('/groups/:id/settlements', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    return c.json(repo.settlements(g.id));
  });

  app.get('/settlements/:id', (c) => {
    const s = repo.settlement(c.req.param('id'));
    if (!s) throw new SattleError('not_found', 'That payment doesn’t exist.');
    repo.groupForUser(s.groupId, c.get('user').id);
    return c.json(s);
  });

  // -- writes --------------------------------------------------------------

  const once = idempotency(db);

  app.post('/groups/:id/expenses', once, async (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    const body = parse(ExpenseBody, await c.req.json());

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

  app.post('/groups/:id/settlements', once, async (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    const body = parse(SettlementBody, await c.req.json());
    if (body.rail === 'manual') {
      throw new SattleError('invalid_expense', 'Use /settlements/manual for manual settlements.');
    }

    const settlement = transaction(db, () => {
      const payee = checkSettlement(repo, g, body);
      if (!canReceive(payee)) {
        throw new SattleError('member_cannot_receive', `${payee.displayName} has nowhere to receive this yet.`);
      }
      const pending = repo.settlements(g.id).find((s) => isInProgress(s) && s.fromMemberId === body.fromMemberId && s.toMemberId === body.toMemberId);
      if (pending) {
        throw new SattleError('conflict', 'A payment for this is already in progress. Wait for it to finish.');
      }
      return repo.insertSettlement(newSettlement(g, body, body.rail, 'created'));
    });

    payments.start(settlement);
    return c.json(settlement, 201);
  });

  app.post('/groups/:id/settlements/manual', once, async (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    const body = parse(ManualBody, await c.req.json());
    const settlement = transaction(db, () => {
      checkSettlement(repo, g, body);
      return repo.insertSettlement({
        ...newSettlement(g, body, 'manual', 'manually_confirmed'),
        note: body.note,
      });
    });
    return c.json(settlement, 201);
  });

  app.put('/members/:id/payout-address', async (c) => {
    const member = repo.member(c.req.param('id'));
    if (!member) throw new SattleError('not_found', 'That member doesn’t exist.');
    repo.groupForUser(member.groupId, c.get('user').id);

    const { address } = parse(AddressBody, await c.req.json(), 'invalid_address');
    const parsed = parseLightningAddress(address);
    if (!parsed.ok) throw new SattleError('invalid_address', parsed.reason);
    // Status stays as-is: a ghost with an address is payable, not joined.
    return c.json(repo.setMemberAddress(member.id, parsed.address));
  });

  return app;
}

// -- helpers ---------------------------------------------------------------

function debtsOf(repo: Repo, g: Group) {
  return simplifyDebts(g.id, computeBalances(g.memberIds, repo.expenses(g.id), repo.settlements(g.id)));
}

/**
 * Both members are in the group, and the amount is no more than the netted
 * debt between them right now. Returns the payee.
 */
function checkSettlement(
  repo: Repo,
  g: Group,
  body: { fromMemberId: string; toMemberId: string; amount: number }
) {
  if (!g.memberIds.includes(body.fromMemberId) || !g.memberIds.includes(body.toMemberId)) {
    throw new SattleError('not_found', 'That member isn’t in this group.');
  }
  if (body.fromMemberId === body.toMemberId) {
    throw new SattleError('invalid_expense', 'Someone can’t settle with themselves.');
  }
  const debt = debtsOf(repo, g).find(
    (d) => d.fromMemberId === body.fromMemberId && d.toMemberId === body.toMemberId
  );
  if (!debt) throw new SattleError('conflict', 'Nothing is owed here any more.');
  if (body.amount > debt.amount) {
    throw new SattleError('conflict', 'That’s more than is owed. Refresh and try again.');
  }
  return repo.member(body.toMemberId)!;
}

/** Non-terminal, and not an awaiting_payment whose quote has lapsed. */
function isInProgress(s: Settlement) {
  if (TERMINAL_STATUSES.includes(s.status)) return false;
  if (s.status === 'awaiting_payment' && s.quote && Date.parse(s.quote.expiresAt) < Date.now()) return false;
  return true;
}

function newSettlement(
  g: Group,
  body: { fromMemberId: string; toMemberId: string; amount: number },
  rail: Settlement['rail'],
  status: Settlement['status']
): Settlement {
  const now = nowIso();
  return {
    id: newId('s'),
    groupId: g.id,
    fromMemberId: body.fromMemberId,
    toMemberId: body.toMemberId,
    amount: body.amount,
    currency: g.currency,
    rail,
    status,
    createdAt: now,
    updatedAt: now,
  };
}

// -- middleware ------------------------------------------------------------

function auth(repo: Repo, demoUserId?: string): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    const header = c.req.header('authorization');
    let user: User | undefined;
    if (header?.startsWith('Bearer ')) {
      user = repo.userByToken(header.slice(7));
    } else if (demoUserId) {
      user = repo.userById(demoUserId);
    }
    if (!user) throw new SattleError('unauthorized', 'Sign in to continue.');
    c.set('user', user);
    await next();
  };
}

/**
 * Replays the first response for a repeated (user, idempotency-key). A key
 * that's still running gets 409 rather than a second execution. Only
 * successful responses are kept; a failed attempt frees the key for a retry.
 */
function idempotency(db: Db): MiddlewareHandler<Env> {
  const find = db.prepare('SELECT route, status, body FROM idempotency_keys WHERE user_id = ? AND key = ?');
  const claim = db.prepare('INSERT INTO idempotency_keys (user_id, key, route, created_at) VALUES (?, ?, ?, ?)');
  const store = db.prepare('UPDATE idempotency_keys SET status = ?, body = ? WHERE user_id = ? AND key = ?');
  const release = db.prepare('DELETE FROM idempotency_keys WHERE user_id = ? AND key = ?');

  return async (c, next) => {
    const key = c.req.header('idempotency-key');
    if (!key) return next();
    const userId = c.get('user').id;
    const route = `${c.req.method} ${c.req.path}`;

    const prior = find.get(userId, key) as { route: string; status: number | null; body: string | null } | undefined;
    if (prior) {
      if (prior.route !== route) throw new SattleError('conflict', 'That request key was already used for something else.');
      if (prior.status === null) throw new SattleError('conflict', 'That request is still being processed.');
      return new Response(prior.body, {
        status: prior.status,
        headers: { 'content-type': 'application/json', 'idempotent-replay': 'true' },
      });
    }

    claim.run(userId, key, route, nowIso());
    try {
      await next();
    } finally {
      if (c.res.ok) store.run(c.res.status, await c.res.clone().text(), userId, key);
      else release.run(userId, key);
    }
  };
}
