/**
 * Group links: someone in a group shares /g/<token>, and whoever opens it
 * sees the whole group with no app and no account: every spend with each
 * person's share, who owes whom, and a way to pay a debt.
 *
 * A pay link shows one debt on purpose. This shows the ledger, so it is the
 * group's own choice: there is no link until someone in the group makes one,
 * there is only ever one, and anyone in the group can replace it or turn it
 * off. Holding it changes nothing in the group; the only thing it can start
 * is a payment, which goes to the person owed like any other.
 *
 * /g/ responses carry names and amounts only, never member or group ids.
 */

import { createHash, randomBytes } from 'node:crypto';

import { Hono } from 'hono';

import { SattleError, canReceive, type Debt, type GroupGuestView, type GroupLink } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { transaction } from '../db';
import { idempotency } from '../middleware';
import { nowIso } from '../repo';
import { debtsOf } from '../settlementRules';
import { newPayLinkToken } from './payLinks';

/** 16 random bytes, base64url: 22 characters, unguessable. */
export const newGroupLinkToken = () => randomBytes(16).toString('base64url');

/**
 * What the page sends back to say which debt to pay. A hash of the link and
 * the pair, so it names the same debt however the amounts move, says nothing
 * about who the members are, and is no use with another link.
 */
const debtRef = (token: string, d: Pick<Debt, 'fromMemberId' | 'toMemberId'>) =>
  createHash('sha256').update(`${token}:${d.fromMemberId}:${d.toMemberId}`).digest('base64url').slice(0, 16);

export function groupLinkRoutes({ db, repo }: Ctx) {
  const r = new Hono<AppEnv>();
  const once = idempotency(db);

  const findLink = (token: string) => {
    const link = repo.groupLink(token);
    if (!link) throw new SattleError('not_found', 'This link is no longer valid.');
    return link;
  };

  const guestView = (link: GroupLink): GroupGuestView => {
    const g = repo.group(link.groupId)!;
    const members = new Map(repo.members(g.id).map((m) => [m.id, m]));
    const name = (id: string) => members.get(id)!.displayName;
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
      debts: debtsOf(repo, g).map((d) => ({
        ref: debtRef(link.token, d),
        from: name(d.fromMemberId),
        to: name(d.toMemberId),
        amount: d.amount,
        payable: canReceive(members.get(d.toMemberId)!),
      })),
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
      const g = repo.group(link.groupId)!;
      const debt = debtsOf(repo, g).find((d) => debtRef(link.token, d) === c.req.param('ref'));
      if (!debt) throw new SattleError('link_expired', 'This has already been settled.');
      const payee = repo.member(debt.toMemberId)!;
      if (!canReceive(payee)) {
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

  return r;
}
