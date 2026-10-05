/**
 * Invites: someone in a group shares /join/<token>, and whoever opens it
 * picks which of the group's ghosts they are, or, if the group hasn't listed
 * them, gives their own name. That makes a request, not a member: someone
 * already in the group has to let them in. A link can be forwarded, and
 * whoever holds it could pick anyone's name, including someone who is owed
 * money; the yes is what stops them becoming that person.
 *
 * Once let in they are a member like any other, so they can read and write
 * everything in the group, which is also why a token is unguessable, expires,
 * and can be replaced or turned off by anyone in the group. It is one link for
 * the whole group, like the group link: there is none until someone makes one,
 * and only ever one.
 *
 * /join/ responses carry names only, never member or group ids, and so does
 * what the person asking is shown of their request.
 */

import { createHash, randomBytes, randomInt } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import { SattleError, type Invite, type InviteView, type JoinRequest, type PendingJoin } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { transaction } from '../db';
import { parse } from '../http';
import { idempotency } from '../middleware';
import { newId, nowIso, type StoredJoinRequest } from '../repo';

/** The token, and who they are: a `ref` from the join page, or their own name if they weren't on it. */
const JoinBody = z.union([
  z.object({ token: z.string().min(1), ref: z.string().min(1) }),
  z.object({ token: z.string().min(1), displayName: z.string().trim().min(1).max(40) }),
]);

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Long enough to send, see and act on; short enough that a stray link dies. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 16 random bytes, base64url: 22 characters, unguessable. */
export const newInviteToken = () => randomBytes(16).toString('base64url');

/**
 * What the page sends back to say who someone is. A hash of the link and the
 * member, so it says nothing about who the members are and is no use with
 * another link.
 */
const memberRef = (token: string, memberId: string) =>
  createHash('sha256').update(`${token}:${memberId}`).digest('base64url').slice(0, 16);

const isLive = (invite: Invite) => Date.parse(invite.expiresAt) > Date.now();

/**
 * How many people can be waiting on one group. Making accounts is free, so
 * without a cap a leaked link could bury the real request under fake ones.
 */
export const MAX_PENDING_JOINS = 20;

/** Four digits, for telling apart two people asking to be the same person. Not a secret. */
const newJoinCode = () => String(randomInt(0, 10_000)).padStart(4, '0');

export function inviteRoutes({ db, repo, wallets }: Ctx) {
  const r = new Hono<AppEnv>();
  const once = idempotency(db);

  /**
   * The invite, if it can still be used.
   *   unknown, replaced or turned off   → 404 not_found
   *   older than INVITE_TTL_MS          → 410 link_expired
   */
  const live = (token: string) => {
    const invite = repo.invite(token);
    if (!invite) throw new SattleError('not_found', 'This invite is no longer valid.');
    if (!isLive(invite)) throw new SattleError('link_expired', 'This invite has expired. Ask for a new one.');
    return invite;
  };

  /** Authed, members only. The group's invite, or null when it has none that still works. */
  r.get('/groups/:id/invites', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    const invite = repo.inviteFor(g.id);
    return c.json(invite && isLive(invite) ? invite : null);
  });

  /**
   * Authed. Anyone in the group can make its invite. Making one when there is
   * one already replaces it, and the old link stops working: that is how a
   * link that went to the wrong place is taken back. Returns 201 Invite.
   */
  r.post('/groups/:id/invites', once, (c) => {
    const user = c.get('user');
    const g = repo.groupForUser(c.req.param('id'), user.id);
    const now = Date.now();
    const invite = transaction(db, () =>
      repo.replaceInvite(
        {
          token: newInviteToken(),
          groupId: g.id,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
        },
        user.id
      )
    );
    return c.json(invite, 201);
  });

  /** Authed. Anyone in the group can turn the invite off. */
  r.delete('/groups/:id/invites', once, (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    repo.deleteInvite(g.id);
    return c.json({ ok: true });
  });

  /** Public, read-only: what the join page shows, and who it offers to join as. */
  r.get('/join/:token', (c) => {
    const invite = live(c.req.param('token'));
    const view: InviteView = {
      groupName: repo.group(invite.groupId)!.name,
      invitedBy: repo.memberForUser(invite.groupId, invite.createdByUserId)?.displayName ?? 'Someone',
      members: repo
        .members(invite.groupId)
        .filter((m) => !m.claimedByUserId)
        .map((m) => ({ ref: memberRef(invite.token, m.id), name: m.displayName })),
    };
    return c.json(view);
  });

  /** What the person asking is shown: names, no ids. */
  const asSeenByAsker = (req: StoredJoinRequest): JoinRequest => ({
    id: req.id,
    groupName: repo.group(req.groupId)!.name,
    name: req.memberId ? repo.member(req.memberId)!.displayName : req.displayName,
    code: req.code,
    status: req.status,
    createdAt: req.createdAt,
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
   * Authed. The signed-in user asks to join the invite's group, and gets
   * their JoinRequest back (201), `pending`. Nothing is theirs until someone
   * in the group lets them in.
   *
   * With a `ref`, they ask to be the ghost they picked on the join page, with
   * the balance already on that name. With a `displayName`, they weren't on
   * the page and ask to be added as a new member. Asking again replaces their
   * last request, so picking the wrong name is fixed by picking the right one.
   *   invite not usable                     → as `live` above
   *   already in this group                 → 409 conflict (one person, one member)
   *   nobody in the group has that ref      → 404 not_found
   *   someone has already joined as them    → 409 conflict
   *   that name is a ghost waiting to join  → 409 conflict: they should pick it,
   *                                           not start a second row beside it
   *   MAX_PENDING_JOINS already waiting     → 409 conflict
   * More than one person can ask to be the same ghost: if one of them could
   * hold the name, a stranger asking first would lock the real person out.
   */
  r.post('/join-requests', once, async (c) => {
    const user = c.get('user');
    const { token, ...who } = parse(JoinBody, await c.req.json());

    const req = transaction(db, () => {
      const invite = live(token);
      if (repo.memberForUser(invite.groupId, user.id)) {
        throw new SattleError('conflict', 'You’re already in this group.');
      }
      const members = repo.members(invite.groupId);
      let memberId: string | undefined;
      let displayName: string;

      if ('displayName' in who) {
        const waiting = members.find((m) => !m.claimedByUserId && sameName(m.displayName, who.displayName));
        if (waiting) {
          throw new SattleError('conflict', `${waiting.displayName} is already in this group. Pick that name to join as them.`);
        }
        displayName = who.displayName;
      } else {
        const member = members.find((m) => memberRef(invite.token, m.id) === who.ref);
        if (!member) throw new SattleError('not_found', 'That person is no longer in this group.');
        if (member.claimedByUserId) throw new SattleError('conflict', `Someone has already joined as ${member.displayName}.`);
        memberId = member.id;
        displayName = member.displayName;
      }

      const mine = repo.joinRequestsOf(user.id).find((x) => x.groupId === invite.groupId && x.status === 'pending');
      if (!mine && repo.pendingJoinCount(invite.groupId) >= MAX_PENDING_JOINS) {
        throw new SattleError('conflict', 'Too many people are waiting to join this group. Ask someone in it to look at who’s waiting.');
      }
      return repo.putJoinRequest({
        id: newId('jr'),
        groupId: invite.groupId,
        userId: user.id,
        memberId,
        displayName,
        code: newJoinCode(),
        createdAt: nowIso(),
      });
    });
    return c.json(asSeenByAsker(req), 201);
  });

  /** Old apps join here and expect to be in. They can't be any more, so they're told to update. */
  r.post('/groups/join', () => {
    throw new SattleError('conflict', 'Joining a group now needs someone in it to let you in. Update Sattle to ask.');
  });

  /** Authed. The user's own requests, waiting or turned down. Names only. */
  r.get('/me/join-requests', (c) => c.json(repo.joinRequestsOf(c.get('user').id).map(asSeenByAsker)));

  /** Authed. The asker takes back a request, or clears one that was turned down. */
  r.delete('/join-requests/:id', once, (c) => {
    repo.deleteJoinRequest(ownRequest(c.req.param('id'), c.get('user').id).id);
    return c.json({ ok: true });
  });

  /** Authed, members only. Who is waiting to be let in, oldest first. */
  r.get('/groups/:id/join-requests', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    const waiting: PendingJoin[] = repo.pendingJoins(g.id).map((req) => ({
      id: req.id,
      name: req.memberId ? repo.member(req.memberId)!.displayName : req.displayName,
      existing: Boolean(req.memberId),
      code: req.code,
      createdAt: req.createdAt,
    }));
    return c.json(waiting);
  });

  /**
   * Authed, anyone in the group. Lets the person in: they become the ghost
   * they asked to be, or a new member under the name they gave, and the
   * request is gone. Anyone else asking to be that ghost is turned down.
   * Returns the Member.
   *   not in the group, or no such request   → 404 not_found
   *   it was already turned down             → 409 conflict
   *   someone has joined as that ghost since → 409 conflict
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
      const status = wallets.connection(req.userId).connected ? 'nwc_linked' : 'joined';
      repo.deleteJoinRequest(req.id);

      if (!req.memberId) {
        return repo.appendMember({ id: newId('m'), groupId: req.groupId, displayName: req.displayName, status, claimedByUserId: req.userId });
      }
      if (!repo.claimMember(req.memberId, req.userId, status)) {
        throw new SattleError('conflict', `Someone has already joined as ${req.displayName}.`);
      }
      repo.declineJoinRequestsFor(req.memberId);
      return repo.member(req.memberId)!;
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
