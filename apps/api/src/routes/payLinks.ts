/**
 * Pay links: the payee shares /s/<token>, the payer opens it with no app and
 * no account. The token grants one debt, never the group — /s/ responses
 * carry names and amounts only, never member or group ids.
 *
 * Each open that needs a fresh invoice inserts a settlement tagged with the
 * link's token (settlements.pay_link_token, migration 002); the guest page
 * always shows the latest one.
 */

import { randomBytes } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import { SattleError, canReceive, toGuestSettlement, type GuestView, type PayLink, type Settlement } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { transaction } from '../db';
import { minor, parse } from '../http';
import { idempotency } from '../middleware';
import { applyProof, hashOfPreimage, ProofBody, readPreimage } from '../proof';
import { nowIso } from '../repo';
import { checkSettlement, debtsOf, inProgressFor, isInProgress, newSettlement } from '../settlementRules';

export const CreatePayLinkBody = z.object({
  fromMemberId: z.string(),
  toMemberId: z.string(),
  amount: minor,
});

/** 16 random bytes, base64url: 22 characters, unguessable. */
export const newPayLinkToken = () => randomBytes(16).toString('base64url');

export function payLinkRoutes({ db, repo, payments }: Ctx) {
  const r = new Hono<AppEnv>();
  const once = idempotency(db);

  const findLink = (token: string) => {
    const link = repo.payLink(token);
    if (!link) throw new SattleError('not_found', 'This link is no longer valid.');
    return link;
  };

  /** With `shown`, that settlement instead of the latest. */
  const guestView = (link: PayLink, shown?: Settlement): GuestView => {
    const latest = shown ?? repo.latestForPayLink(link.token);
    return {
      payerName: repo.member(link.fromMemberId)!.displayName,
      payeeName: repo.member(link.toMemberId)!.displayName,
      reason: repo.group(link.groupId)!.name,
      settlement: latest && toGuestSettlement(latest),
    };
  };

  /**
   * Authed. Only the person owed (the user who claimed toMemberId) can create
   * a link for their debt; anyone else gets 400 invalid_input. The amount is
   * capped at what's owed right now. Returns 201 PayLink.
   *
   * Several links for one debt are allowed (re-sending makes a new one) and
   * safe: opening any of them refuses while another payment for the pair is
   * in progress, and once one is paid the debt is smaller than the rest, so
   * they expire.
   */
  r.post('/groups/:id/pay-links', once, async (c) => {
    const user = c.get('user');
    const g = repo.groupForUser(c.req.param('id'), user.id);
    const body = parse(CreatePayLinkBody, await c.req.json());

    const link = transaction(db, () => {
      const payee = repo.member(body.toMemberId);
      if (!payee || payee.groupId !== g.id) throw new SattleError('not_found', 'That member isn’t in this group.');
      if (payee.claimedByUserId !== user.id) {
        throw new SattleError('invalid_input', `Only ${payee.displayName} can send a link for this.`);
      }
      checkSettlement(repo, g, body);
      return repo.insertPayLink({ token: newPayLinkToken(), groupId: g.id, ...body, createdAt: nowIso() }, user.id);
    });
    return c.json(link, 201);
  });

  /**
   * Public, called once when the guest page loads. Mints the invoice now, not
   * when the link was made — BOLT11 expires in minutes.
   *   unknown token                         → 404 not_found
   *   a settlement for it is in progress    → return it (no second invoice)
   *   last settlement confirmed             → return it (page shows Paid)
   *   debt gone or smaller than the link    → 410 link_expired
   *   payee can't receive                   → 409 member_cannot_receive
   *   paying the same debt another way      → 409 conflict
   *   otherwise: insert a settlement with rail 'invoice', payments.start(it),
   *   return the GuestView.
   */
  r.post('/s/:token/open', once, (c) => {
    const link = findLink(c.req.param('token'));

    const started = transaction(db, () => {
      const latest = repo.latestForPayLink(link.token);
      if (latest && (isInProgress(latest) || latest.status === 'confirmed')) return undefined;

      const g = repo.group(link.groupId)!;
      const debt = debtsOf(repo, g).find(
        (d) => d.fromMemberId === link.fromMemberId && d.toMemberId === link.toMemberId
      );
      if (!debt || debt.amount < link.amount) {
        throw new SattleError('link_expired', 'This has already been settled.');
      }
      const payee = repo.member(link.toMemberId)!;
      if (!canReceive(payee)) {
        throw new SattleError('member_cannot_receive', `${payee.displayName} has nowhere to receive this yet.`);
      }
      if (inProgressFor(repo, g, link)) {
        throw new SattleError('conflict', 'A payment for this is already in progress. Wait for it to finish.');
      }

      const s = repo.insertSettlement(newSettlement(g, link, 'invoice', 'created'));
      repo.attachToPayLink(s.id, link.token);
      return s;
    });

    // start() only schedules work, so this reads the row as it is right now.
    if (started) payments.start(started);
    return c.json(guestView(link));
  });

  /** Public, read-only, polled by the guest page. GuestView with the latest settlement. */
  r.get('/s/:token', (c) => c.json(guestView(findLink(c.req.param('token')))));

  /**
   * Public. The guest's proof of payment for any invoice this link opened,
   * not just the latest: they may have paid an older one. Returns the
   * GuestView showing the settlement it proved.
   *   not 64 hex characters                  → 400 invalid_input
   *   for no invoice this link opened        → 400 invalid_input, same
   *     message whether or not it exists elsewhere
   */
  r.post('/s/:token/proof', once, async (c) => {
    const link = findLink(c.req.param('token'));
    const preimage = readPreimage(parse(ProofBody, await c.req.json()).preimage);
    const s = repo.settlementByPaymentHash(hashOfPreimage(preimage));
    if (!s || repo.invoiceOf(s.id)?.payLinkToken !== link.token) {
      throw new SattleError('invalid_input', 'That proof is for a different payment.');
    }
    return c.json(guestView(link, applyProof(repo, s, preimage)));
  });

  return r;
}
