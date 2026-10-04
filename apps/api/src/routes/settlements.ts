import { Hono } from 'hono';
import { z } from 'zod';

import { SattleError, canReceive } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { transaction } from '../db';
import { minor, parse } from '../http';
import { idempotency } from '../middleware';
import { checkManualRecorder, checkPayer, checkSettlement, inProgressFor, newSettlement } from '../settlementRules';

const SettlementBody = z.object({
  fromMemberId: z.string(),
  toMemberId: z.string(),
  amount: minor,
  rail: z.enum(['in_app', 'lightning_address', 'invoice', 'manual']),
});

const ManualBody = SettlementBody.omit({ rail: true }).extend({
  note: z.string().trim().max(200).optional(),
});

export function settlementRoutes({ db, repo, payments }: Ctx) {
  const r = new Hono<AppEnv>();
  const once = idempotency(db);

  r.get('/groups/:id/settlements', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    return c.json(repo.settlements(g.id));
  });

  r.get('/settlements/:id', (c) => {
    const s = repo.settlement(c.req.param('id'));
    if (!s) throw new SattleError('not_found', 'That payment doesn’t exist.');
    repo.groupForUser(s.groupId, c.get('user').id);
    return c.json(s);
  });

  r.post('/groups/:id/settlements', once, async (c) => {
    const user = c.get('user');
    const g = repo.groupForUser(c.req.param('id'), user.id);
    const body = parse(SettlementBody, await c.req.json());
    if (body.rail === 'manual') {
      throw new SattleError('invalid_input', 'Use /settlements/manual for manual settlements.');
    }

    const settlement = transaction(db, () => {
      const payee = checkSettlement(repo, g, body);
      checkPayer(repo, body, user.id);
      if (!canReceive(payee)) {
        throw new SattleError('member_cannot_receive', `${payee.displayName} has nowhere to receive this yet.`);
      }
      if (inProgressFor(repo, g, body)) {
        throw new SattleError('conflict', 'A payment for this is already in progress. Wait for it to finish.');
      }
      return repo.insertSettlement(newSettlement(g, body, body.rail, 'created'));
    });

    payments.start(settlement);
    return c.json(settlement, 201);
  });

  /** The payee records it; the payer only when the payee is a ghost. See checkManualRecorder. */
  r.post('/groups/:id/settlements/manual', once, async (c) => {
    const user = c.get('user');
    const g = repo.groupForUser(c.req.param('id'), user.id);
    const body = parse(ManualBody, await c.req.json());
    const settlement = transaction(db, () => {
      checkSettlement(repo, g, body);
      checkManualRecorder(repo, body, user.id);
      return repo.insertSettlement({
        ...newSettlement(g, body, 'manual', 'manually_confirmed'),
        note: body.note,
      });
    });
    return c.json(settlement, 201);
  });

  return r;
}
