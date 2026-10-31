/**
 * Pay links: /s/<token>, one debt, opened with no app and no account. The
 * group's page hands one out when someone on it chooses a debt to pay
 * (groupLinks.ts); nothing else makes one. The token grants that one debt,
 * never the group — /s/ responses carry names and amounts only, never
 * member or group ids.
 *
 * A link can be paid whichever way the person owed can be paid.
 *
 * Over Lightning, each open that needs a fresh invoice inserts a settlement
 * tagged with the link's token (settlements.pay_link_token, migration 002);
 * the guest page always shows the latest one.
 *
 * In a rupee group it can also be paid by UPI, to someone who has a UPI ID
 * and hasn't turned that off for shared links, the same rule as the group's
 * link (upi.ts). The page says it was paid, which is a claim and moves
 * nothing; when the person owed confirms it, that settlement is tagged with
 * the token too, so the link shows it paid.
 *
 * A debt can be settled without the link: marked settled by the person owed,
 * or paid by UPI from the app. The link shows that settlement then, so a page
 * left open says it's settled instead of still offering to be paid.
 *
 * With both on offer, nothing is minted until the payer says which: an
 * invoice nobody asked for would stand in the way of the UPI payment.
 */

import { randomBytes } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import {
  LEDGER_STATUSES,
  SattleError,
  settledOutsideLink,
  toGuestSettlement,
  toGuestSettlementFromElsewhere,
  type Group,
  type GuestView,
  type PayLink,
  type Settlement,
  type UpiPayee,
} from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { transaction } from '../db';
import { parse } from '../http';
import { receivable } from '../payments';
import { idempotency } from '../middleware';
import { applyProof, hashOfPreimage, ProofBody, readPreimage } from '../proof';
import { newId, nowIso } from '../repo';
import { debtsOf, inProgressFor, isInProgress, newSettlement } from '../settlementRules';
import { upiIdFor, upiOnLink } from './upi';

/** What the page sends once the payer has chosen Lightning over UPI. Nothing, until then. */
const OpenBody = z.object({ rail: z.literal('lightning').optional() });

/** 16 random bytes, base64url: 22 characters, unguessable. */
export const newPayLinkToken = () => randomBytes(16).toString('base64url');

export function payLinkRoutes({ db, repo, payments, wallets }: Ctx) {
  const r = new Hono<AppEnv>();
  const once = idempotency(db);

  const findLink = (token: string) => {
    const link = repo.payLink(token);
    if (!link) throw new SattleError('not_found', 'This link is no longer valid.');
    return link;
  };

  /** What is owed between the link's two people now, if it still covers the link. */
  const owed = (link: PayLink, g: Group) => {
    const debt = debtsOf(repo, g).find((d) => d.fromMemberId === link.fromMemberId && d.toMemberId === link.toMemberId);
    return debt && debt.amount >= link.amount ? debt : undefined;
  };

  /**
   * What settled the link's debt some other way, if something did (see
   * settledOutsideLink). The page shows it settled rather than still asking
   * to be paid.
   */
  const settledElsewhere = (link: PayLink) => settledOutsideLink(repo.settlements(link.groupId), link);

  /** A UPI payment someone has said they made for the link's debt, from here or anywhere else. */
  const claimFor = (link: PayLink) =>
    repo.upiClaims(link.groupId).find((x) => x.fromMemberId === link.fromMemberId && x.toMemberId === link.toMemberId);

  /** With `shown`, that settlement instead of the latest. */
  const guestView = (link: PayLink, shown?: Settlement): GuestView => {
    const own = shown ?? repo.latestForPayLink(link.token);
    const g = repo.group(link.groupId)!;
    const elsewhere = !shown && !(own && LEDGER_STATUSES.includes(own.status)) ? settledElsewhere(link) : undefined;
    const latest = elsewhere ?? own;
    const payee = repo.member(link.toMemberId)!;
    // Once it's settled, a claim still about it has nothing left to wait for.
    const claim = elsewhere ? undefined : claimFor(link);
    return {
      payerName: repo.member(link.fromMemberId)!.displayName,
      payeeName: payee.displayName,
      reason: g.name,
      amount: link.amount,
      currency: g.currency,
      payable: receivable(payments, payee),
      ...(upiOnLink(wallets, g, payee) ? { upi: true } : {}),
      ...(claim ? { upiClaim: claim.status } : {}),
      ...(claim?.anotherWay ? { claimAnotherWay: true as const } : {}),
      settlement: latest && (elsewhere ? toGuestSettlementFromElsewhere(latest) : toGuestSettlement(latest)),
    };
  };

  /**
   * The link's debt, for paying it by UPI. 410 once the link has been paid or
   * the debt is no longer owed, 409 if UPI isn't a way to pay it.
   */
  const upiDebt = (link: PayLink) => {
    const g = repo.group(link.groupId)!;
    const latest = repo.latestForPayLink(link.token);
    // A link pays once. The same two people may still owe as much again, and that takes a new link.
    if ((latest && LEDGER_STATUSES.includes(latest.status)) || settledElsewhere(link) || !owed(link, g)) {
      throw new SattleError('link_expired', 'This has already been settled.');
    }
    const payee = repo.member(link.toMemberId)!;
    if (!upiOnLink(wallets, g, payee)) {
      throw new SattleError('member_cannot_receive', `${payee.displayName} can’t be paid by UPI from here.`);
    }
    return { g, payee };
  };

  /**
   * Public, called once when the guest page loads, and again with
   * `{ rail: 'lightning' }` once the payer has chosen Lightning. Returns the
   * GuestView, which says how the link can be paid (`payable`, `upi`). Mints
   * the invoice now, not when the link was made — BOLT11 expires in minutes.
   *   unknown token                         → 404 not_found
   *   a settlement for it is in progress    → return it (no second invoice)
   *   last settlement settled it            → return it (page shows Paid)
   *   settled some other way since the link → return that (page shows it settled)
   *   debt gone or smaller than the link    → 410 link_expired
   *   payee can be paid neither way         → 409 member_cannot_receive
   *   someone said it was paid by UPI       → nothing minted: paying again
   *                                           would pay twice
   *   it can be paid by UPI, and the payer
   *   hasn't chosen Lightning               → nothing minted: the page asks
   *   Lightning chosen, payee can't take it → 409 member_cannot_receive
   *   paying the same debt another way      → 409 conflict
   *   otherwise: insert a settlement with rail 'invoice', payments.start(it).
   */
  r.post('/s/:token/open', once, async (c) => {
    const link = findLink(c.req.param('token'));
    // The page sends no body at all until there is a choice to send.
    const { rail } = parse(OpenBody, await c.req.json().catch(() => ({})));

    const started = transaction(db, () => {
      const latest = repo.latestForPayLink(link.token);
      if (latest && (isInProgress(latest) || LEDGER_STATUSES.includes(latest.status))) return undefined;

      const g = repo.group(link.groupId)!;
      if (settledElsewhere(link)) return undefined;
      if (!owed(link, g)) throw new SattleError('link_expired', 'This has already been settled.');
      const payee = repo.member(link.toMemberId)!;
      const lightning = receivable(payments, payee);
      const upi = upiOnLink(wallets, g, payee);
      if (!lightning && !upi) {
        throw new SattleError('member_cannot_receive', `${payee.displayName} has nowhere to receive this yet.`);
      }
      if (claimFor(link)?.status === 'pending') return undefined;
      if (upi && rail !== 'lightning') return undefined;
      if (!lightning) {
        throw new SattleError('member_cannot_receive', `${payee.displayName} can’t be paid over Lightning yet. Pay by UPI.`);
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

  /**
   * Public. Where to pay the link's debt by UPI: UpiPayee. The ID isn't in
   * the GuestView; it is given here, to someone who has asked to pay.
   *   unknown token                              → 404 not_found
   *   the debt is no longer owed                 → 410 link_expired
   *   not in rupees, no UPI ID, or turned off    → 409 member_cannot_receive
   */
  r.get('/s/:token/upi', (c) => {
    const { payee } = upiDebt(findLink(c.req.param('token')));
    const body: UpiPayee = { upiId: upiIdFor(wallets, payee)!, name: payee.displayName };
    return c.json(body);
  });

  /**
   * Public. Someone on the link says the debt was paid by UPI. It moves
   * nothing: the person owed sees it, marked as coming from a link, and
   * confirms it or says it didn't arrive. Returns 201 `{ ok: true }`.
   *   as for /upi above
   *   a Lightning payment for it is under way    → 409 conflict
   * A claim already waiting for this debt is left as it is: the link can't
   * replace what the payer said in the app.
   */
  r.post('/s/:token/upi-claims', once, (c) => {
    const link = findLink(c.req.param('token'));
    transaction(db, () => {
      const { g } = upiDebt(link);
      if (inProgressFor(repo, g, link)) {
        throw new SattleError('conflict', 'A payment for this is already in progress. Wait for it to finish.');
      }
      if (claimFor(link)?.status === 'pending') return;
      repo.replaceUpiClaim(
        {
          id: newId('uc'),
          groupId: g.id,
          fromMemberId: link.fromMemberId,
          toMemberId: link.toMemberId,
          amount: link.amount,
          status: 'pending',
          viaLink: true,
          createdAt: nowIso(),
        },
        link.token
      );
    });
    return c.json({ ok: true }, 201);
  });

  return r;
}
