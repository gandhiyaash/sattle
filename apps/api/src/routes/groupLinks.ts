/**
 * Group links: someone in a group shares /g/<token>, and whoever opens it
 * sees the whole group with no app and no account: every spend with each
 * person's share, who owes whom, and a way to pay a debt.
 *
 * A pay link shows one debt on purpose. This shows the ledger, so it is the
 * group's own choice: there is no link until someone in the group makes one,
 * there is only ever one, and anyone in the group can replace it or turn it
 * off. Holding it changes nothing in the group. It can start a payment,
 * which goes to the person owed like any other, and it can be used to ask to
 * join (invites.ts), which someone in the group has to say yes to.
 *
 * In a rupee group, a debt can also be paid by UPI from here, to someone who
 * has a UPI ID and hasn't turned that off for shared links. The
 * page says it was paid (a claim, as in upi.ts), and the person owed is the
 * one who confirms it, so holding the link still can't settle anything.
 *
 * /g/ responses carry names and amounts only, never member or group ids. A
 * UPI ID is given only for one debt at a time, when someone asks to pay it.
 */

import { createHash, randomBytes } from 'node:crypto';

import { Hono } from 'hono';

import { SattleError, UPI_CURRENCY, type Debt, type Group, type GroupGuestView, type GroupLink, type UpiPayee } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { transaction } from '../db';
import { idempotency } from '../middleware';
import { receivable } from '../payments';
import { newId, nowIso } from '../repo';
import { debtsOf, inProgressFor } from '../settlementRules';
import { newPayLinkToken } from './payLinks';
import { takesUpiOnLinks } from './upi';

/** 16 random bytes, base64url: 22 characters, unguessable. */
export const newGroupLinkToken = () => randomBytes(16).toString('base64url');

/**
 * What the page sends back to say which debt to pay. A hash of the link and
 * the pair, so it names the same debt however the amounts move, says nothing
 * about who the members are, and is no use with another link.
 */
const debtRef = (token: string, d: Pick<Debt, 'fromMemberId' | 'toMemberId'>) =>
  createHash('sha256').update(`${token}:${d.fromMemberId}:${d.toMemberId}`).digest('base64url').slice(0, 16);

export function groupLinkRoutes({ db, repo, payments, wallets }: Ctx) {
  const r = new Hono<AppEnv>();
  const once = idempotency(db);

  const findLink = (token: string) => {
    const link = repo.groupLink(token);
    if (!link) throw new SattleError('not_found', 'This link is no longer valid.');
    return link;
  };

  /** The debt the page means by `ref`, as it is now. 410 link_expired once it's no longer owed. */
  const findDebt = (link: GroupLink, ref: string) => {
    const g = repo.group(link.groupId)!;
    const debt = debtsOf(repo, g).find((d) => debtRef(link.token, d) === ref);
    if (!debt) throw new SattleError('link_expired', 'This has already been settled.');
    return { g, debt };
  };

  /** Whether the person owed takes UPI from this page. */
  const upiHere = (g: Group, toMemberId: string) =>
    g.currency === UPI_CURRENCY && takesUpiOnLinks(wallets, repo.member(toMemberId)!);

  /** The payee, for a debt someone wants to pay by UPI from the page. 409 member_cannot_receive if they can't be. */
  const upiPayee = (link: GroupLink, ref: string) => {
    const { g, debt } = findDebt(link, ref);
    const payee = repo.member(debt.toMemberId)!;
    if (!upiHere(g, payee.id)) {
      throw new SattleError('member_cannot_receive', `${payee.displayName} can’t be paid by UPI from here.`);
    }
    return { g, debt, payee };
  };

  const guestView = (link: GroupLink): GroupGuestView => {
    const g = repo.group(link.groupId)!;
    const members = new Map(repo.members(g.id).map((m) => [m.id, m]));
    const name = (id: string) => members.get(id)!.displayName;
    const claims = repo.upiClaims(g.id);
    return {
      groupName: g.name,
      currency: g.currency,
      expenses: repo.expenses(g.id).map((e) => ({
        description: e.description,
        amount: e.amount,
        paidBy: name(e.paidByMemberId),
        shares: e.parts.map((p) => ({ name: name(p.memberId), amount: p.amount })),
        createdAt: e.createdAt,
      })),
      debts: debtsOf(repo, g).map((d) => {
        const claim = claims.find((x) => x.fromMemberId === d.fromMemberId && x.toMemberId === d.toMemberId);
        return {
          ref: debtRef(link.token, d),
          from: name(d.fromMemberId),
          to: name(d.toMemberId),
          amount: d.amount,
          payable: receivable(payments, members.get(d.toMemberId)!),
          ...(upiHere(g, d.toMemberId) ? { upi: true } : {}),
          ...(claim ? { upiClaim: claim.status } : {}),
        };
      }),
    };
  };

  /** Authed, members only. The group's link, or null when it has none. */
  r.get('/groups/:id/link', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    return c.json(repo.groupLinkFor(g.id) ?? null);
  });

  /**
   * Authed. Anyone in the group can make its link. Making one when there is
   * one already replaces it, and the old link stops working: that is how a
   * link that went to the wrong place is taken back. Returns 201 GroupLink.
   */
  r.post('/groups/:id/link', once, (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    const link = transaction(db, () =>
      repo.replaceGroupLink({ token: newGroupLinkToken(), groupId: g.id, createdAt: nowIso() })
    );
    return c.json(link, 201);
  });

  /** Authed. Anyone in the group can turn the link off. */
  r.delete('/groups/:id/link', once, (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    repo.deleteGroupLink(g.id);
    return c.json({ ok: true });
  });

  /** Public, read-only: what the group page shows. 404 for a link that was replaced or turned off. */
  r.get('/g/:token', (c) => c.json(guestView(findLink(c.req.param('token')))));

  /**
   * Public. Someone on the group page chose a debt to pay. Returns `{ token }`,
   * a pay link for that debt at what it is right now; the page opens it like
   * any pay link, which is where the invoice is minted and the rules about
   * amounts and payments in progress are applied.
   *   unknown group link                 → 404 not_found
   *   that debt is no longer owed        → 410 link_expired
   *   the person owed can't receive      → 409 member_cannot_receive
   * Asking again for the same debt and amount returns the same pay link, so
   * a public route can't be used to pile up rows.
   */
  r.post('/g/:token/debts/:ref/pay-link', once, (c) => {
    const link = findLink(c.req.param('token'));

    const token = transaction(db, () => {
      const { g, debt } = findDebt(link, c.req.param('ref'));
      const payee = repo.member(debt.toMemberId)!;
      if (!receivable(payments, payee)) {
        throw new SattleError('member_cannot_receive', `${payee.displayName} has nowhere to receive this yet.`);
      }
      const existing = repo.payLinkFor(debt);
      if (existing) return existing.token;
      // A pay link belongs to an account: the payee's, or for a ghost, the group's first.
      const owner = payee.claimedByUserId ?? repo.firstAccountIn(g.id)!;
      return repo.insertPayLink(
        {
          token: newPayLinkToken(),
          groupId: g.id,
          fromMemberId: debt.fromMemberId,
          toMemberId: debt.toMemberId,
          amount: debt.amount,
          createdAt: nowIso(),
        },
        owner
      ).token;
    });
    return c.json({ token }, 201);
  });

  /**
   * Public. Where to pay a debt on the page by UPI: UpiPayee. Only for a debt
   * owed to someone who has a UPI ID and lets shared links show it.
   *   unknown group link                         → 404 not_found
   *   that debt is no longer owed                → 410 link_expired
   *   not in rupees, no UPI ID, or turned off    → 409 member_cannot_receive
   */
  r.get('/g/:token/debts/:ref/upi', (c) => {
    const { payee } = upiPayee(findLink(c.req.param('token')), c.req.param('ref'));
    const body: UpiPayee = { upiId: wallets.upiId(payee.claimedByUserId!)!, name: payee.displayName };
    return c.json(body);
  });

  /**
   * Public. Someone on the page says the debt was paid by UPI. It moves
   * nothing: the person owed sees it, marked as coming from the link, and
   * confirms it or says it didn't arrive. Returns 201 `{ ok: true }`.
   *   as for /upi above
   *   a Lightning payment for it is under way    → 409 conflict
   * A claim already waiting for this debt, from the page or from the payer
   * in the app, is left as it is: the link can't replace what the payer said.
   */
  r.post('/g/:token/debts/:ref/upi-claims', once, (c) => {
    const link = findLink(c.req.param('token'));
    transaction(db, () => {
      const { g, debt } = upiPayee(link, c.req.param('ref'));
      if (inProgressFor(repo, g, debt)) {
        throw new SattleError('conflict', 'A payment for this is already in progress. Wait for it to finish.');
      }
      const waiting = repo
        .upiClaims(g.id)
        .find((x) => x.fromMemberId === debt.fromMemberId && x.toMemberId === debt.toMemberId && x.status === 'pending');
      if (waiting) return;
      repo.replaceUpiClaim({
        id: newId('uc'),
        groupId: g.id,
        fromMemberId: debt.fromMemberId,
        toMemberId: debt.toMemberId,
        amount: debt.amount,
        status: 'pending',
        viaLink: true,
        createdAt: nowIso(),
      });
    });
    return c.json({ ok: true }, 201);
  });

  return r;
}
