/**
 * Joining: the group's shared link (/g/<token>, see groupLinks.ts) also lets
 * whoever holds it join. They pick which of the group's ghosts they are, or,
 * if the group hasn't listed them, give their own name, and they are in: a
 * member like any other, who can read and write everything in the group.
 *
 * A group can ask to look first (Group.approveJoins, off until someone in the
 * group turns it on under Manage). Then picking a name makes a request, not a
 * member, and someone already in the group has to let them in. A link can be
 * forwarded, and whoever holds it could pick anyone's name, including someone
 * who is owed money; the yes is what stops them becoming that person. The
 * request carries a four-digit code both sides see, to tell two people asking
 * for one name apart.
 *
 * Someone who joined and then lost the phone or browser they joined with asks
 * the same way, whatever the group chose, picking their own name from the
 * ones already joined. Letting them in hands that name to their new account
 * and takes it from the old one, so the yes has to come from the old device,
 * or from someone who can vouch (repo.vouches): who made the group, or was
 * let in by someone who could. Someone who got in by the link alone can't,
 * or one throwaway account joining would be all it took to take anyone's name.
 *
 * The link doesn't run out by itself: anyone in the group can replace it or
 * turn it off, and the requests waiting on it can be turned down.
 *
 * It is the same token throughout: /g/<token> is the page that shows the
 * group, and /join/<token> is where someone says who they are. /join/
 * responses carry names only, never member or group ids, and so does what
 * the person asking is shown of their request.
 */

import { createHash, randomInt } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import { SattleError, type GroupLink, type JoinView, type JoinRequest, type Member, type PendingJoin } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { transaction } from '../db';
import { checkNothingIncoming } from '../groupRules';
import { parse } from '../http';
import { idempotency } from '../middleware';
import { newId, nowIso, type StoredJoinRequest } from '../repo';

/** The token, and who they are: a `ref` from the join page, or their own name if they weren't on it. */
const JoinBody = z.union([
  z.object({ token: z.string().min(1), ref: z.string().min(1) }),
  z.object({ token: z.string().min(1), displayName: z.string().trim().min(1).max(40) }),
]);

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * What the page sends back to say who someone is. A hash of the link and the
 * member, so it says nothing about who the members are and is no use with
 * another link.
 */
const memberRef = (token: string, memberId: string) =>
  createHash('sha256').update(`${token}:${memberId}`).digest('base64url').slice(0, 16);

/**
 * How many people can be waiting on one group. Making accounts is free, so
 * without a cap a leaked link could bury the real request under fake ones.
 */
export const MAX_PENDING_JOINS = 20;

/** Four digits, for telling apart two people asking to be the same person. Not a secret. */
const newJoinCode = () => String(randomInt(0, 10_000)).padStart(4, '0');

/**
 * Who someone joins as. `memberId` is the member they picked, if they picked
 * one; `holder` is the account that has that name, if someone has joined as
 * it. With neither, they're added under `displayName`.
 */
interface Who {
  memberId?: string;
  displayName: string;
  holder?: string;
}

export function joinRoutes({ db, repo, wallets }: Ctx) {
  const r = new Hono<AppEnv>();
  const once = idempotency(db);

  /** The group's link, if it is still the one that works. 404 not_found once it was replaced or turned off. */
  const live = (token: string) => {
    const link = repo.groupLink(token);
    if (!link) throw new SattleError('not_found', 'This link is no longer valid.');
    return link;
  };

  /**
   * Who the body says they are, among `members` of the link's group.
   *   nobody in the group has that ref      → 404 not_found
   *   that name is a ghost waiting to join  → 409 conflict: they should pick it,
   *                                           not start a second row beside it
   */
  const whoIs = (link: GroupLink, who: { ref: string } | { displayName: string }, members: Member[]): Who => {
    if ('displayName' in who) {
      const waiting = members.find((m) => !m.claimedByUserId && sameName(m.displayName, who.displayName));
      if (waiting) {
        throw new SattleError('conflict', `${waiting.displayName} is already in this group. Pick that name to join as them.`);
      }
      return { displayName: who.displayName };
    }
    const member = members.find((m) => memberRef(link.token, m.id) === who.ref);
    if (!member) throw new SattleError('not_found', 'That person is no longer in this group.');
    return { memberId: member.id, displayName: member.displayName, holder: member.claimedByUserId };
  };

  /** The status a new member gets: `nwc_linked` if they have a wallet connected, like their other groups, else `joined`. */
  const statusFor = (userId: string): Exclude<Member['status'], 'ghost'> =>
    wallets.connection(userId).connected ? 'nwc_linked' : 'joined';

  /**
   * Makes them the member they picked, a new one under the name they gave,
   * after everyone else, or, with a `holder`, hands that member over from the
   * holder's account. Anyone else asking to be that member is turned down.
   * `vouched`: whether they can vouch for others in their turn.
   *   someone has joined as the ghost since    → 409 conflict
   *   a payment to the holder is under way     → 409 conflict
   */
  const admit = (groupId: string, userId: string, who: Who, vouched: boolean): Member => {
    const status = statusFor(userId);
    if (!who.memberId) {
      return repo.appendMember({ id: newId('m'), groupId, displayName: who.displayName, status, claimedByUserId: userId }, vouched);
    }
    if (who.holder) {
      // It lands on their wallet and their member, so it finishes before the name moves.
      checkNothingIncoming(repo, who.holder, groupId, `A payment to ${who.displayName} is still in progress. Wait for it to finish.`);
      repo.handOverMember(who.memberId, who.holder, userId, status, vouched);
    } else if (!repo.claimMember(who.memberId, userId, status, vouched)) {
      throw new SattleError('conflict', `Someone has already joined as ${who.displayName}.`);
    }
    repo.declineJoinRequestsFor(who.memberId);
    return repo.member(who.memberId)!;
  };

  /** Public, read-only: what the join page shows, who it offers to join as, and who already has. */
  r.get('/join/:token', (c) => {
    const link = live(c.req.param('token'));
    const members = repo.members(link.groupId);
    const group = repo.group(link.groupId)!;
    const view: JoinView = {
      groupName: group.name,
      approveJoins: group.approveJoins,
      members: members
        .filter((m) => !m.claimedByUserId)
        .map((m) => ({ ref: memberRef(link.token, m.id), name: m.displayName })),
      joined: members.filter((m) => m.claimedByUserId).map((m) => m.displayName),
      // The same people, for someone taking their own place back from a device they lost.
      rejoin: members
        .filter((m) => m.claimedByUserId)
        .map((m) => ({ ref: memberRef(link.token, m.id), name: m.displayName })),
    };
    return c.json(view);
  });

  /**
   * Authed. The link's group, when the caller is already in it; null when
   * they aren't. The link is the one in the group's chat, so the people in
   * the group open it too, and the join page has nobody to offer them: the
   * app opens the group instead. The Group is only for someone in it. It
   * isn't under /join/ or /g/, which answer without an account.
   *   link not usable   → as `live` above
   */
  r.get('/links/:token/group', (c) => {
    const link = live(c.req.param('token'));
    const user = c.get('user');
    const mine = repo.memberForUser(link.groupId, user.id);
    return c.json(mine ? repo.groupForUser(link.groupId, user.id) : null);
  });

  /**
   * Authed. The signed-in user joins the link's group, and gets their Member
   * back (201). With a `ref`, they become the ghost they picked on the join
   * page, with the balance already on that name. With a `displayName`, they
   * weren't on the page and are added as a new member. A request they had
   * waiting on this group is gone: they're in. They can't vouch for anyone
   * (repo.vouches): nobody said yes to them.
   *   link not usable                       → as `live` above
   *   already in this group                 → 409 conflict (one person, one member)
   *   the group has to let people in        → 409 conflict: ask (/join-requests)
   *   that name is someone's account        → 409 conflict: taking it back is
   *                                           asked for, whatever the group chose
   *   a new name someone has joined as      → 409 conflict: nobody is there to
   *                                           see two people go by one name
   *   as `whoIs` above
   */
  r.post('/join', once, async (c) => {
    const user = c.get('user');
    const { token, ...who } = parse(JoinBody, await c.req.json());

    const member = transaction(db, () => {
      const link = live(token);
      if (repo.memberForUser(link.groupId, user.id)) {
        throw new SattleError('conflict', 'You’re already in this group.');
      }
      const group = repo.group(link.groupId)!;
      if (group.approveJoins) {
        throw new SattleError('conflict', `Someone in ${group.name} has to let you in. Ask to join instead.`);
      }
      const members = repo.members(link.groupId);
      const picked = whoIs(link, who, members);
      if (picked.holder) {
        throw new SattleError(
          'conflict',
          `${picked.displayName} has already joined. To take the name back, ask, and someone in the group lets you in.`
        );
      }
      const taken = !picked.memberId && members.find((m) => m.claimedByUserId && sameName(m.displayName, picked.displayName));
      if (taken) {
        throw new SattleError(
          'conflict',
          `${taken.displayName} has already joined. If that’s you, pick ${taken.displayName} on the list. Otherwise give a name that tells you apart.`
        );
      }
      const asked = repo.joinRequestsOf(user.id).find((x) => x.groupId === link.groupId);
      if (asked) repo.deleteJoinRequest(asked.id);
      return admit(link.groupId, user.id, picked, false);
    });
    return c.json(member, 201);
  });

  /** What the person asking is shown: names, no ids. */
  const asSeenByAsker = (req: StoredJoinRequest): JoinRequest => ({
    id: req.id,
    groupName: repo.group(req.groupId)!.name,
    name: req.memberId ? repo.member(req.memberId)!.displayName : req.displayName,
    code: req.code,
    status: req.status,
    createdAt: req.createdAt,
    ...(req.replacesUserId && { takesOver: true }),
  });

  /** A request, for someone in its group. Anyone else gets not_found, as for the group itself. */
  const requestFor = (id: string, userId: string) => {
    const req = repo.joinRequest(id);
    if (!req) throw new SattleError('not_found', 'Nobody is waiting to join with that request.');
    repo.groupForUser(req.groupId, userId);
    return req;
  };

  /** The person who asked, for their own request. */
  const ownRequest = (id: string, userId: string) => {
    const req = repo.joinRequest(id);
    if (!req || req.userId !== userId) throw new SattleError('not_found', 'That request isn’t there any more.');
    return req;
  };

  /**
   * The account a request would take the name from, while that account still
   * has it. Otherwise the name is a ghost again, and the request is for that.
   */
  const holderFor = (req: StoredJoinRequest) => {
    const holder = req.memberId ? repo.member(req.memberId)!.claimedByUserId : undefined;
    return req.replacesUserId && holder === req.replacesUserId ? holder : undefined;
  };

  /**
   * Authed. The signed-in user asks to join the link's group, and gets
   * their JoinRequest back (201), `pending`. Nothing is theirs until someone
   * in the group lets them in. This is the way in to a group that approves
   * joins, and the only way to take a name back; a group that doesn't can
   * still be asked, and the answer is the same yes.
   *
   * With a `ref`, they ask to be the ghost they picked on the join page, with
   * the balance already on that name. With a `ref` from `rejoin`, they ask to
   * take back a name they joined as before, from the account that has it; the
   * request names that account, and letting them in only hands the name over
   * while that account still has it. With a `displayName`, they weren't on
   * the page and ask to be added as a new member. Asking again replaces their
   * last request, so picking the wrong name is fixed by picking the right one.
   *   link not usable                       → as `live` above
   *   already in this group                 → 409 conflict (one person, one member)
   *   as `whoIs` above
   *   MAX_PENDING_JOINS already waiting     → 409 conflict
   * More than one person can ask to be the same ghost: if one of them could
   * hold the name, a stranger asking first would lock the real person out.
   */
  r.post('/join-requests', once, async (c) => {
    const user = c.get('user');
    const { token, ...who } = parse(JoinBody, await c.req.json());

    const req = transaction(db, () => {
      const link = live(token);
      if (repo.memberForUser(link.groupId, user.id)) {
        throw new SattleError('conflict', 'You’re already in this group.');
      }
      const picked = whoIs(link, who, repo.members(link.groupId));
      const mine = repo.joinRequestsOf(user.id).find((x) => x.groupId === link.groupId && x.status === 'pending');
      if (!mine && repo.pendingJoinCount(link.groupId) >= MAX_PENDING_JOINS) {
        throw new SattleError('conflict', 'Too many people are waiting to join this group. Ask someone in it to look at who’s waiting.');
      }
      return repo.putJoinRequest({
        id: newId('jr'),
        groupId: link.groupId,
        userId: user.id,
        memberId: picked.memberId,
        displayName: picked.displayName,
        code: newJoinCode(),
        createdAt: nowIso(),
        replacesUserId: picked.holder,
      });
    });
    return c.json(asSeenByAsker(req), 201);
  });

  /** Authed. The user's own requests, waiting or turned down. Names only. */
  r.get('/me/join-requests', (c) => c.json(repo.joinRequestsOf(c.get('user').id).map(asSeenByAsker)));

  /** Authed. The asker takes back a request, or clears one that was turned down. */
  r.delete('/join-requests/:id', once, (c) => {
    repo.deleteJoinRequest(ownRequest(c.req.param('id'), c.get('user').id).id);
    return c.json({ ok: true });
  });

  /**
   * Authed, members only. Who is waiting to be let in, oldest first. Someone
   * asking to take over a name someone else has is left out for whoever can't
   * vouch for them (repo.vouches), since that person can't let them in.
   */
  r.get('/groups/:id/join-requests', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    const me = c.get('user').id;
    const vouches = repo.vouches(g.id, me);
    const waiting: PendingJoin[] = repo
      .pendingJoins(g.id)
      .map((req) => ({ req, replacing: holderFor(req) }))
      .filter(({ replacing }) => !replacing || replacing === me || vouches)
      .map(({ req, replacing }) => ({
        id: req.id,
        name: req.memberId ? repo.member(req.memberId)!.displayName : req.displayName,
        existing: Boolean(req.memberId),
        code: req.code,
        createdAt: req.createdAt,
        ...(replacing && { replacing: replacing === me ? ('you' as const) : ('someone' as const) }),
      }));
    return c.json(waiting);
  });

  /**
   * Authed, anyone in the group. Lets the person in: they become the ghost
   * they asked to be, or a new member under the name they gave, and the
   * request is gone. Anyone else asking to be that ghost is turned down.
   * They can vouch for others as far as whoever let them in could.
   * Returns the Member.
   *
   * A request to take a name back from the account that has it hands the
   * member over: that account leaves the group as if it had left, and the
   * asker takes the name as it is. Whoever has the name can say yes to this,
   * which is how an old device hands its place to a new one, and so can
   * anyone who can vouch (repo.vouches).
   *   not in the group, or no such request   → 404 not_found
   *   it was already turned down             → 409 conflict
   *   someone has joined as that ghost since → 409 conflict (for a takeover:
   *                                            anyone but the account it named)
   *   a payment to that account is under way → 409 conflict
   *   a takeover, from someone who joined by
   *   the link alone                         → 400 invalid_input
   * The member is `joined`, or `nwc_linked` if they have a wallet connected,
   * like the members they have in other groups.
   */
  r.post('/join-requests/:id/approve', once, (c) => {
    const user = c.get('user');
    const member = transaction(db, () => {
      const req = requestFor(c.req.param('id'), user.id);
      if (req.status !== 'pending') throw new SattleError('conflict', `${req.displayName} was already turned down.`);
      if (repo.memberForUser(req.groupId, req.userId)) {
        throw new SattleError('conflict', `${req.displayName} is already in this group.`);
      }
      const holder = holderFor(req);
      const vouches = repo.vouches(req.groupId, user.id);
      if (holder && holder !== user.id && !vouches) {
        throw new SattleError(
          'invalid_input',
          `You joined by the link alone, so you can’t hand over ${req.displayName}’s place. Someone who made the group or was let in with a yes can.`
        );
      }
      repo.deleteJoinRequest(req.id);
      return admit(req.groupId, req.userId, { memberId: req.memberId, displayName: req.displayName, holder }, vouches);
    });
    return c.json(member);
  });

  /** Authed, anyone in the group. Turns the request down; the person asking is shown that. */
  r.post('/join-requests/:id/decline', once, (c) => {
    const req = requestFor(c.req.param('id'), c.get('user').id);
    repo.declineJoinRequest(req.id);
    return c.json({ ok: true });
  });

  return r;
}
