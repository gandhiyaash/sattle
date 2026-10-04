/**
 * Invites: someone in a group shares /join/<token>, and whoever opens it
 * picks which of the group's ghosts they are and, with an account, takes that
 * ghost over. That makes them a member like any other, so they can read and
 * write everything in the group. Nothing here can take that back, which is
 * why a token is unguessable, expires, and can be replaced or turned off by
 * anyone in the group. It is one link for the whole group, like the group
 * link: there is none until someone makes one, and only ever one.
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

const JoinBody = z.object({ token: z.string().min(1), ref: z.string().min(1) });

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

  /**
   * Authed. The signed-in user becomes the ghost they picked on the join page,
   * with the balance already on that name. Returns the Group they're now in.
   *   invite not usable                 → as `live` above
   *   already in this group             → 409 conflict (one person, one member)
   *   nobody in the group has that ref  → 404 not_found
   *   someone else joined as them first → 409 conflict
   * The member is `joined`, or `nwc_linked` if the user has a wallet connected,
   * like the members they have in other groups.
   */
  r.post('/groups/join', once, async (c) => {
    const user = c.get('user');
    const { token, ref } = parse(JoinBody, await c.req.json());

    const groupId = transaction(db, () => {
      const invite = live(token);
      if (repo.memberForUser(invite.groupId, user.id)) {
        throw new SattleError('conflict', 'You’re already in this group.');
      }
      const member = repo.members(invite.groupId).find((m) => memberRef(invite.token, m.id) === ref);
      if (!member) throw new SattleError('not_found', 'That person is no longer in this group.');
      const status = wallets.connection(user.id).connected ? 'nwc_linked' : 'joined';
      if (member.claimedByUserId || !repo.claimMember(member.id, user.id, status)) {
        throw new SattleError('conflict', `Someone has already joined as ${member.displayName}.`);
      }
      return invite.groupId;
    });
    return c.json(repo.groupForUser(groupId, user.id));
  });

  return r;
}
