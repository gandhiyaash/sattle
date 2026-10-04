/**
 * Invites: a member shares /join/<token>, and whoever opens it with an
 * account takes over one ghost. That makes them a member like any other, so
 * they can read and write everything in the group. Nothing here can take
 * that back, which is why a token is unguessable, works once, expires, and
 * stops working as soon as a newer one is made for the same ghost.
 *
 * /join/ responses carry names only, never member or group ids.
 */

import { randomBytes } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import { SattleError, type InviteView } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { transaction } from '../db';
import { parse } from '../http';
import { idempotency } from '../middleware';

export const CreateInviteBody = z.object({ memberId: z.string() });

const JoinBody = z.object({ token: z.string().min(1) });

/** Long enough to send, see and act on; short enough that a stray link dies. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 16 random bytes, base64url: 22 characters, unguessable. */
export const newInviteToken = () => randomBytes(16).toString('base64url');

export function inviteRoutes({ db, repo, wallets }: Ctx) {
  const r = new Hono<AppEnv>();
  const once = idempotency(db);

  /**
   * The invite and the ghost it's for, if it can still be used.
   *   unknown, or replaced by a newer one   → 404 not_found
   *   older than INVITE_TTL_MS              → 410 link_expired
   *   the ghost has since been claimed      → 410 link_expired
   */
  const live = (token: string) => {
    const invite = repo.invite(token);
    if (!invite) throw new SattleError('not_found', 'This invite is no longer valid.');
    if (Date.parse(invite.expiresAt) <= Date.now()) {
      throw new SattleError('link_expired', 'This invite has expired. Ask for a new one.');
    }
    const member = repo.member(invite.memberId)!;
    if (member.claimedByUserId) throw new SattleError('link_expired', 'This invite has already been used.');
    return { invite, member };
  };

  /**
   * Authed. Anyone in the group can invite one of its ghosts. Returns 201
   * Invite. Making another for the same ghost replaces the last one, so a
   * link sent to the wrong place can be killed by sending a new one.
   */
  r.post('/groups/:id/invites', once, async (c) => {
    const user = c.get('user');
    const g = repo.groupForUser(c.req.param('id'), user.id);
    const { memberId } = parse(CreateInviteBody, await c.req.json());

    const invite = transaction(db, () => {
      const member = repo.member(memberId);
      if (!member || member.groupId !== g.id) throw new SattleError('not_found', 'That member isn’t in this group.');
      if (member.claimedByUserId) throw new SattleError('conflict', `${member.displayName} has already joined.`);
      const now = Date.now();
      return repo.insertInvite(
        {
          token: newInviteToken(),
          groupId: g.id,
          memberId: member.id,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
        },
        user.id
      );
    });
    return c.json(invite, 201);
  });

  /** Public, read-only: what the join page shows before anyone commits. */
  r.get('/join/:token', (c) => {
    const { invite, member } = live(c.req.param('token'));
    const view: InviteView = {
      groupName: repo.group(invite.groupId)!.name,
      memberName: member.displayName,
      invitedBy: repo.memberForUser(invite.groupId, invite.createdByUserId)?.displayName ?? 'Someone',
    };
    return c.json(view);
  });

  /**
   * Authed. The signed-in user becomes the invite's ghost, with the balance
   * already on that name. Returns the Group they're now in.
   *   invite not usable                 → as `live` above
   *   already in this group             → 409 conflict (one person, one member)
   * The member is `joined`, or `nwc_linked` if the user has a wallet connected,
   * like the members they have in other groups.
   */
  r.post('/groups/join', once, async (c) => {
    const user = c.get('user');
    const { token } = parse(JoinBody, await c.req.json());

    const groupId = transaction(db, () => {
      const { invite, member } = live(token);
      if (repo.memberForUser(invite.groupId, user.id)) {
        throw new SattleError('conflict', 'You’re already in this group.');
      }
      const status = wallets.connection(user.id).connected ? 'nwc_linked' : 'joined';
      if (!repo.claimMember(member.id, user.id, status)) {
        throw new SattleError('link_expired', 'This invite has already been used.');
      }
      return invite.groupId;
    });
    return c.json(repo.groupForUser(groupId, user.id));
  });

  return r;
}
