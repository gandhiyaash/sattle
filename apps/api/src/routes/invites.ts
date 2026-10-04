/**
 * Invites: someone in a group shares /join/<token>, and whoever opens it
 * picks which of the group's ghosts they are and, with an account, takes that
 * ghost over. Someone the group hasn't listed adds themselves instead, as a
 * new member. Either way they are a member like any other, so they can read
 * and write everything in the group. Nothing here can take that back, which is
 * why a token is unguessable, expires, and can be replaced or turned off by
 * anyone in the group. It is the group's one link: there is none until
 * someone makes one, and only ever one.
 *
 * /join/ responses carry names only, never member or group ids.
 */

import { createHash, randomBytes } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import { SattleError, type Invite, type InviteView } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { transaction } from '../db';
import { parse } from '../http';
import { idempotency } from '../middleware';
import { newId } from '../repo';

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

  /** Public, read-only: what the join page shows, who it offers to join as, and who already has. */
  r.get('/join/:token', (c) => {
    const invite = live(c.req.param('token'));
    const members = repo.members(invite.groupId);
    const view: InviteView = {
      groupName: repo.group(invite.groupId)!.name,
      invitedBy: repo.memberForUser(invite.groupId, invite.createdByUserId)?.displayName ?? 'Someone',
      members: members
        .filter((m) => !m.claimedByUserId)
        .map((m) => ({ ref: memberRef(invite.token, m.id), name: m.displayName })),
      // Names only, with no ref: there is nothing to send back for someone who can't be picked.
      joined: members.filter((m) => m.claimedByUserId).map((m) => m.displayName),
    };
    return c.json(view);
  });

  /**
   * Authed. The invite's group, when the caller is already in it; null when
   * they aren't. The link is the one in the group's chat, so the people in
   * the group open it too, and the join page has nobody to offer them: the
   * app opens the group instead. Only someone in the group is told which
   * group it is. It isn't under /join/, which answers without an account.
   *   invite not usable   → as `live` above
   */
  r.get('/invites/:token/group', (c) => {
    const invite = live(c.req.param('token'));
    const user = c.get('user');
    const mine = repo.memberForUser(invite.groupId, user.id);
    return c.json(mine ? repo.groupForUser(invite.groupId, user.id) : null);
  });

  /**
   * Authed. The signed-in user joins the invite's group and gets the Group back.
   *
   * With a `ref`, they become the ghost they picked on the join page, with the
   * balance already on that name. With a `displayName`, they weren't on the
   * page: they are added as a new member, after everyone else.
   *   invite not usable                     → as `live` above
   *   already in this group                 → 409 conflict (one person, one member)
   *   nobody in the group has that ref      → 404 not_found
   *   someone else joined as them first     → 409 conflict
   *   that name is a ghost waiting to join  → 409 conflict: they should pick it,
   *                                           not start a second row beside it
   * The member is `joined`, or `nwc_linked` if the user has a wallet connected,
   * like the members they have in other groups.
   */
  r.post('/groups/join', once, async (c) => {
    const user = c.get('user');
    const { token, ...who } = parse(JoinBody, await c.req.json());

    const groupId = transaction(db, () => {
      const invite = live(token);
      if (repo.memberForUser(invite.groupId, user.id)) {
        throw new SattleError('conflict', 'You’re already in this group.');
      }
      const members = repo.members(invite.groupId);
      const status = wallets.connection(user.id).connected ? 'nwc_linked' : 'joined';

      if ('displayName' in who) {
        const waiting = members.find((m) => !m.claimedByUserId && sameName(m.displayName, who.displayName));
        if (waiting) {
          throw new SattleError('conflict', `${waiting.displayName} is already in this group. Pick that name to join as them.`);
        }
        repo.appendMember({ id: newId('m'), groupId: invite.groupId, displayName: who.displayName, status, claimedByUserId: user.id });
        return invite.groupId;
      }

      const member = members.find((m) => memberRef(invite.token, m.id) === who.ref);
      if (!member) throw new SattleError('not_found', 'That person is no longer in this group.');
      if (member.claimedByUserId || !repo.claimMember(member.id, user.id, status)) {
        throw new SattleError('conflict', `Someone has already joined as ${member.displayName}.`);
      }
      return invite.groupId;
    });
    return c.json(repo.groupForUser(groupId, user.id));
  });

  return r;
}
