/**
 * Pay links: the payee shares /s/<token>, the payer opens it with no app and
 * no account. The token grants one debt, never the group — /s/ responses
 * carry names and amounts only, never member or group ids.
 *
 * Needs migration 002: a pay_links table (token, group, from, to, amount,
 * created_by_user_id, created_at) and a way to find the link's current
 * settlement (e.g. settlements.pay_link_token).
 */

import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv, Ctx } from '../context';
import { minor, notImplemented, parse } from '../http';
import { idempotency } from '../middleware';

export const CreatePayLinkBody = z.object({
  fromMemberId: z.string(),
  toMemberId: z.string(),
  amount: minor,
});

export function payLinkRoutes({ db, repo }: Ctx) {
  const r = new Hono<AppEnv>();
  const once = idempotency(db);

  /**
   * Authed. Only the person owed (the user who claimed toMemberId) can create
   * a link for their debt; anyone else gets 400 invalid_input. Run
   * checkSettlement so the amount is capped at what's owed. Token: 16 random
   * bytes, base64url. Returns 201 PayLink. Seed fixtures.payLinks too.
   */
  r.post('/groups/:id/pay-links', once, async (c) => {
    repo.groupForUser(c.req.param('id'), c.get('user').id);
    parse(CreatePayLinkBody, await c.req.json());
    return notImplemented('Pay links');
  });

  /**
   * Public, called once when the guest page loads. Mints the invoice now, not
   * when the link was made — BOLT11 expires in minutes.
   *   unknown token                         → 404 not_found
   *   a settlement for it is in progress    → return it (no second invoice)
   *   last settlement confirmed             → return it (page shows Paid)
   *   debt gone or smaller than the link    → 410 link_expired
   *   payee can't receive                   → 409 member_cannot_receive
   *   otherwise: insert a settlement with rail 'invoice', payments.start(it),
   *   return the GuestView.
   */
  r.post('/s/:token/open', once, () => notImplemented('Pay links'));

  /** Public, read-only, polled by the guest page. GuestView with the latest settlement. */
  r.get('/s/:token', () => notImplemented('Pay links'));

  return r;
}
