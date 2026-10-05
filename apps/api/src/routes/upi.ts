/**
 * UPI: settling a rupee debt outside Lightning.
 *
 * Someone puts their UPI ID on their account. Whoever owes them is shown it,
 * pays from their own UPI app, and tells us they did: a claim. Sattle can't
 * see the payment, since no bank or app tells a third party that one person
 * paid another, so a claim moves nothing. The person owed confirms it, which
 * makes it a settlement like "mark as settled", or says it didn't arrive.
 * It is the payee's word to give, the same rule as checkManualRecorder.
 *
 * A UPI ID often holds a phone number, so it isn't in the member list.
 * Someone who owes that person right now can read it, and so can whoever
 * holds one of their groups' shared links, for the debt they choose to pay
 * (see groupLinks.ts). That second part the person can turn off, for every
 * group they're in or for one.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import {
  SattleError,
  UPI_CURRENCY,
  parseUpiId,
  type Group,
  type Member,
  type UpiClaim,
  type UpiOnGroupLink,
  type UpiPayee,
  type UpiProfile,
} from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { transaction } from '../db';
import { minor, parse } from '../http';
import { idempotency } from '../middleware';
import { newId, nowIso } from '../repo';
import { checkPayer, checkSettlement, debtsOf, inProgressFor, newSettlement } from '../settlementRules';
import type { WalletStore } from '../walletStore';

const UpiBody = z.object({ upiId: z.string().max(320) });

const OnLinksBody = z.object({ on: z.boolean() });

/** `null` is no choice for this group: it goes back to following the one for all of them. */
const OnOneLinkBody = z.object({ on: z.boolean().nullable() });

const ClaimBody = z.object({
  fromMemberId: z.string(),
  toMemberId: z.string(),
  amount: minor,
  reference: z.string().trim().min(1).max(64).optional(),
});

/** Whether this member has given a UPI ID to be paid at. A ghost has no account to have put one on. */
export const takesUpi = (wallets: WalletStore, member: Member) =>
  Boolean(member.claimedByUserId && wallets.upiId(member.claimedByUserId));

/** What applies to this member's group: what they chose for it, or else what they chose for all their groups. */
const upiOnLinkOf = (wallets: WalletStore, member: Member): UpiOnGroupLink => {
  const choice = wallets.upiOnLinkChoice(member.id);
  return { on: choice ?? wallets.upiOnLinks(member.claimedByUserId!), choice };
};

/** Whether this member can be paid by UPI from their group's shared link: they have an ID and haven't turned that off. */
export const takesUpiOnLinks = (wallets: WalletStore, member: Member) =>
  takesUpi(wallets, member) && upiOnLinkOf(wallets, member).on;

export function upiRoutes({ db, repo, wallets }: Ctx) {
  const r = new Hono<AppEnv>();
  const once = idempotency(db);

  const checkRupees = (g: Group) => {
    if (g.currency !== UPI_CURRENCY) throw new SattleError('invalid_input', 'UPI only works for a group in rupees.');
  };

  /** The payee's UPI ID, or 409 member_cannot_receive when they have none. */
  const upiIdOf = (payee: Member) => {
    const upiId = payee.claimedByUserId && wallets.upiId(payee.claimedByUserId);
    if (!upiId) throw new SattleError('member_cannot_receive', `${payee.displayName} hasn’t added a UPI ID.`);
    return upiId;
  };

  const findClaim = (id: string) => {
    const claim = repo.upiClaim(id);
    if (!claim) throw new SattleError('not_found', 'That UPI payment isn’t waiting any more.');
    return claim;
  };

  const profileOf = (userId: string): UpiProfile => ({
    upiId: wallets.upiId(userId) ?? null,
    onGroupLinks: wallets.upiOnLinks(userId),
  });

  /** UpiProfile: the user's own UPI ID, or null, and whether shared links may show it. */
  r.get('/me/upi', (c) => c.json(profileOf(c.get('user').id)));

  /** Sets the user's own UPI ID, for every group they're in. 400 invalid_input when it isn't one. */
  r.put('/me/upi', async (c) => {
    const parsed = parseUpiId(parse(UpiBody, await c.req.json()).upiId);
    if (!parsed.ok) throw new SattleError('invalid_input', parsed.reason);
    wallets.setUpiId(c.get('user').id, parsed.upiId);
    return c.json(profileOf(c.get('user').id));
  });

  /**
   * Whether the user's groups' shared links may show their UPI ID, so anyone
   * holding one can pay them by UPI. It is on from the start, with nothing to
   * show until they give an ID; this is how they turn it off, or on again.
   */
  r.put('/me/upi/group-links', async (c) => {
    const user = c.get('user');
    const { on } = parse(OnLinksBody, await c.req.json());
    wallets.setUpiOnLinks(user.id, on);
    return c.json(profileOf(user.id));
  });

  /** UpiOnGroupLink: whether this group's shared link may show the user's UPI ID, and whether they chose that for it alone. */
  r.get('/me/upi/group-links/:groupId', (c) => {
    const user = c.get('user');
    const g = repo.groupForUser(c.req.param('groupId'), user.id);
    return c.json(upiOnLinkOf(wallets, repo.memberForUser(g.id, user.id)!));
  });

  /**
   * The same choice for one group, which wins over the one for all of them:
   * off here while on everywhere else, or the other way round. `on: null`
   * goes back to following it. Returns UpiOnGroupLink. Like the one above it
   * is only a choice: the link offers UPI when they also have an ID and the
   * group is in rupees.
   */
  r.put('/me/upi/group-links/:groupId', async (c) => {
    const user = c.get('user');
    const g = repo.groupForUser(c.req.param('groupId'), user.id);
    const { on } = parse(OnOneLinkBody, await c.req.json());
    const me = repo.memberForUser(g.id, user.id)!;
    wallets.setUpiOnLinkChoice(me.id, on);
    return c.json(upiOnLinkOf(wallets, me));
  });

  /** Claims already made stay: the payer has paid, and the payee still has to say whether it arrived. */
  r.delete('/me/upi', (c) => {
    wallets.setUpiId(c.get('user').id, null);
    return c.json(profileOf(c.get('user').id));
  });

  /**
   * UpiPayee: where to pay this member over UPI. For someone who owes them.
   *   the group isn't in rupees        → 400 invalid_input
   *   the caller owes them nothing     → 409 conflict
   *   they haven't given a UPI ID      → 409 member_cannot_receive
   */
  r.get('/groups/:id/members/:memberId/upi', (c) => {
    const user = c.get('user');
    const g = repo.groupForUser(c.req.param('id'), user.id);
    const payee = repo.member(c.req.param('memberId'));
    if (!payee || payee.groupId !== g.id) throw new SattleError('not_found', 'That member isn’t in this group.');
    checkRupees(g);
    const me = repo.memberForUser(g.id, user.id)!;
    if (!debtsOf(repo, g).some((d) => d.fromMemberId === me.id && d.toMemberId === payee.id)) {
      throw new SattleError('conflict', `You don’t owe ${payee.displayName} anything right now.`);
    }
    const body: UpiPayee = { upiId: upiIdOf(payee), name: payee.displayName };
    return c.json(body);
  });

  /** The claims the user is part of in this group: the ones they made, and the ones waiting on them. */
  r.get('/groups/:id/upi-claims', (c) => {
    const user = c.get('user');
    const g = repo.groupForUser(c.req.param('id'), user.id);
    const me = repo.memberForUser(g.id, user.id)!;
    return c.json(repo.upiClaims(g.id).filter((x) => x.fromMemberId === me.id || x.toMemberId === me.id));
  });

  /**
   * The payer says they paid over UPI. Returns 201 UpiClaim, `pending`. It
   * takes the place of an earlier claim for the same debt, so paying again
   * after being told it didn't arrive doesn't need the old one cleared.
   *   not the payer, more than is owed, nothing owed   → as for any payment
   *   the group isn't in rupees                        → 400 invalid_input
   *   the payee hasn't given a UPI ID                  → 409 member_cannot_receive
   *   a Lightning payment for it is under way          → 409 conflict
   */
  r.post('/groups/:id/upi-claims', once, async (c) => {
    const user = c.get('user');
    const g = repo.groupForUser(c.req.param('id'), user.id);
    const body = parse(ClaimBody, await c.req.json());

    const claim = transaction(db, () => {
      const payee = checkSettlement(repo, g, body);
      checkPayer(repo, body, user.id);
      checkRupees(g);
      upiIdOf(payee);
      if (inProgressFor(repo, g, body)) {
        throw new SattleError('conflict', 'A payment for this is already in progress. Wait for it to finish.');
      }
      const made: UpiClaim = {
        id: newId('uc'),
        groupId: g.id,
        fromMemberId: body.fromMemberId,
        toMemberId: body.toMemberId,
        amount: body.amount,
        reference: body.reference,
        status: 'pending',
        createdAt: nowIso(),
      };
      return repo.replaceUpiClaim(made);
    });
    return c.json(claim, 201);
  });

  /**
   * The person owed says it arrived. The claim becomes a settlement, already
   * counted (`manually_confirmed`, rail `upi`), and is gone. One they'd said
   * didn't arrive can still be confirmed, if it turned up after all.
   *   not the person owed                       → 400 invalid_input
   *   less than that is owed now, or nothing    → 409 conflict
   */
  r.post('/upi-claims/:id/confirm', once, (c) => {
    const user = c.get('user');
    const claim = findClaim(c.req.param('id'));
    const g = repo.groupForUser(claim.groupId, user.id);

    const settlement = transaction(db, () => {
      const payee = repo.member(claim.toMemberId)!;
      if (payee.claimedByUserId !== user.id) {
        throw new SattleError('invalid_input', `Only ${payee.displayName} can confirm this.`);
      }
      checkSettlement(repo, g, claim);
      repo.deleteUpiClaim(claim.id);
      return repo.insertSettlement({
        ...newSettlement(g, claim, 'upi', 'manually_confirmed'),
        note: claim.reference ? `Paid by UPI, ref ${claim.reference}` : 'Paid by UPI',
        recordedByMemberId: payee.id,
      });
    });
    return c.json(settlement);
  });

  /** The person owed says it didn't arrive. Returns the UpiClaim, `declined`, which the payer is then shown. */
  r.post('/upi-claims/:id/decline', once, (c) => {
    const user = c.get('user');
    const claim = findClaim(c.req.param('id'));
    repo.groupForUser(claim.groupId, user.id);
    const payee = repo.member(claim.toMemberId)!;
    if (payee.claimedByUserId !== user.id) {
      throw new SattleError('invalid_input', `Only ${payee.displayName} can say whether this arrived.`);
    }
    return c.json(repo.setUpiClaimStatus(claim.id, 'declined'));
  });

  /** The payer takes it back: they didn't pay after all, or they've seen that it was declined. */
  r.delete('/upi-claims/:id', once, (c) => {
    const user = c.get('user');
    const claim = findClaim(c.req.param('id'));
    repo.groupForUser(claim.groupId, user.id);
    const payer = repo.member(claim.fromMemberId)!;
    if (payer.claimedByUserId !== user.id) {
      throw new SattleError('invalid_input', `Only ${payer.displayName} can take this back.`);
    }
    repo.deleteUpiClaim(claim.id);
    return c.json({ ok: true });
  });

  return r;
}
