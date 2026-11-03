/**
 * GET /sync: everything the app's main screens show, in one answer (SyncView):
 * who the user is, each of their groups whole, the groups they've asked to
 * join, and their UPI ID.
 *
 * The app keeps a copy and opens on it (apps/mobile/src/data/AppData.ts), and
 * asks here again behind it: at launch, every few seconds while a screen with
 * balances is up, and after each change. That replaces a request per piece:
 * the groups list made 2 + 3 per group, and the group screen 8 every 4 s.
 *
 * Every part is built by the same function as the route that answers it on
 * its own (GET /groups/:id, /members, /expenses, /settlements, /upi-claims,
 * /join-requests, /me, /me/upi, /me/join-requests), so the app shows the same
 * thing either way. sync.test.ts holds them to it, byte for byte.
 *
 * `?group=<id>`, as many as needed, answers for those groups only: the rest of
 * the answer is the same. It's for a screen keeping one group current, which
 * shouldn't have every other group built for it every few seconds. A group the
 * user isn't in is left out, never refused, so this route doesn't answer 404,
 * and an app that gets one is talking to a server from before it.
 *
 * The answer's version is a hash of it, in the body and as a weak ETag. Asked
 * with `If-None-Match` and nothing has changed, it's a 304 with no body: the
 * app is told so in a few bytes. Everything is read with no await in between,
 * so an answer is one moment of the database, where eight requests could each
 * catch it at a different one.
 */

import { createHash } from 'node:crypto';

import { Hono } from 'hono';

import { SattleError, groupDebts, isHeldBy, type Group, type GroupSnapshot, type SyncView } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { membersOf } from './groups';
import { joinRequestsOfUser, pendingJoinsOf } from './joining';
import { upiClaimsFor, upiProfileOf } from './upi';

export function syncRoutes(ctx: Ctx) {
  const { repo, wallets } = ctx;
  const r = new Hono<AppEnv>();

  /** The groups asked for that the user is in, by id; all of theirs, as GET /groups lists them, without `group`. */
  const groupsFor = (userId: string, only: string[] | undefined): Group[] => {
    if (!only) return repo.groupsForUser(userId);
    // In one order, so the same groups asked for in another are the same answer, with the same version.
    return [...new Set(only)].sort().flatMap((id) => {
      try {
        return [repo.groupForUser(id, userId)];
      } catch (e) {
        if (e instanceof SattleError && e.code === 'not_found') return [];
        throw e;
      }
    });
  };

  r.get('/sync', (c) => {
    const user = c.get('user');
    const view: SyncView = {
      user,
      groups: groupsFor(user.id, c.req.queries('group')).map((group): GroupSnapshot => {
        const members = membersOf(ctx, group.id);
        const me = members.find((m) => isHeldBy(m, user.id));
        const expenses = repo.expenses(group.id);
        const settlements = repo.settlements(group.id);
        return {
          group,
          members,
          expenses,
          settlements,
          // The debts are worked out once, from what was just read, rather than read again for the claims.
          upiClaims: me ? upiClaimsFor(repo, group, me.id, groupDebts(group, expenses, settlements)) : [],
          pendingJoins: pendingJoinsOf(repo, group.id, user.id),
        };
      }),
      joinRequests: joinRequestsOfUser(repo, user.id),
      upiProfile: upiProfileOf(wallets, user.id),
    };

    const json = JSON.stringify(view);
    const version = createHash('sha1').update(json).digest('base64url');
    // No cache keeps it: the app has its own copy, and a phone's HTTP cache would only answer for the server.
    const headers = { ETag: `W/"${version}"`, 'Cache-Control': 'private, no-store' };
    if (names(c.req.header('if-none-match'), version)) return c.body(null, 304, headers);
    return c.body(`{"version":${JSON.stringify(version)},${json.slice(1)}`, 200, {
      ...headers,
      'Content-Type': 'application/json',
    });
  });

  return r;
}

/** Whether an If-None-Match names this version: compared weakly, as RFC 9110 says it is, or `*`. */
function names(header: string | undefined, version: string): boolean {
  if (!header) return false;
  return header.split(',').some((t) => {
    const tag = t.trim();
    return tag === '*' || tag.replace(/^W\//, '') === `"${version}"`;
  });
}
