import type { MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';

import { ANALYTICS_HEADERS, ANALYTICS_LIMITS, SattleError, type User } from '@sattle/core';

import type { AppEnv } from './context';
import { transaction, type Db } from './db';
import { newId, nowIso, type Repo } from './repo';

/**
 * Reachable without signing in: the guest pay page under /s/, the group page
 * under /g/, who its link offers to join as under /join/, making an
 * account, signing in with Nostr under /auth/, and the app reporting how it is used under
 * /analytics/, since a guest on a pay page counts too. Joining is not here: that needs an account, so it lives at
 * POST /join, and asking at POST /join-requests. Making or removing a group link isn't either:
 * /groups/:id/link.
 */
const PUBLIC_PREFIXES = ['/health', '/s/', '/g/', '/join/', '/accounts', '/auth/', '/analytics/'];

/** Where a sign-in key is replaced. The one route an old key can reach, and only for a replay. */
export const REPLACE_KEY_PATH = '/me/token';

export const isPublic = (path: string) => PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p));

export function auth(repo: Repo, demoUserId?: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS' || isPublic(c.req.path)) return next();
    const header = c.req.header('authorization');
    let user: User | undefined;
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7);
      user = repo.userByToken(token);
      // The key a device held when it asked for a new one, retrying because the answer was
      // lost. It gets that answer replayed, and nothing else: see POST /me/token.
      if (!user && c.req.method === 'POST' && c.req.path === REPLACE_KEY_PATH) {
        user = repo.userByPreviousToken(token);
        if (user) c.set('replacedKey', true);
      }
    } else if (demoUserId) {
      user = repo.userById(demoUserId);
    }
    if (!user) throw new SattleError('unauthorized', 'Sign in to continue.');
    c.set('user', user);
    await next();
  };
}

/**
 * Replays the first response for a repeated (user, idempotency-key). A key
 * that's still running gets 409 rather than a second execution. Only
 * successful responses are kept; a failed attempt frees the key for a retry.
 * Public routes key on 'guest' instead of a user.
 */
export function idempotency(db: Db): MiddlewareHandler<AppEnv> {
  const find = db.prepare('SELECT route, status, body FROM idempotency_keys WHERE user_id = ? AND key = ?');
  const claim = db.prepare('INSERT INTO idempotency_keys (user_id, key, route, created_at) VALUES (?, ?, ?, ?)');
  const store = db.prepare('UPDATE idempotency_keys SET status = ?, body = ? WHERE user_id = ? AND key = ?');
  const release = db.prepare('DELETE FROM idempotency_keys WHERE user_id = ? AND key = ?');

  return async (c, next) => {
    const key = c.req.header('idempotency-key');
    if (!key) return next();
    const userId = c.get('user')?.id ?? 'guest';
    const route = `${c.req.method} ${c.req.path}`;

    const prior = find.get(userId, key) as { route: string; status: number | null; body: string | null } | undefined;
    if (prior) {
      if (prior.route !== route) throw new SattleError('conflict', 'That request key was already used for something else.');
      if (prior.status === null) throw new SattleError('conflict', 'That request is still being processed.');
      return new Response(prior.body, {
        status: prior.status,
        headers: { 'content-type': 'application/json', 'idempotent-replay': 'true' },
      });
    }

    claim.run(userId, key, route, nowIso());
    try {
      await next();
    } finally {
      if (c.res.ok) store.run(c.res.status, await c.res.clone().text(), userId, key);
      else release.run(userId, key);
    }
  };
}

/** How long a request row is kept. */
export const REQUEST_LOG_DAYS = 30;
/** How long an event the app reported without an account is kept. */
export const GUEST_EVENT_DAYS = 30;

/**
 * Drops request rows older than REQUEST_LOG_DAYS, and what the app reported
 * without an account older than GUEST_EVENT_DAYS; server.ts runs it on start
 * and daily. A screen that keeps itself current (a group, every 4 s while
 * it shows) asks about 900 times an hour, so without this the request log
 * would outgrow everything else on the disk. Guest rows are the ones anyone
 * can post, so they can't be kept for ever either. What accounts report of
 * themselves stays: there is far less of it, and it's what a statistics page
 * counts. Rows are dropped by when they arrived, since a device's clock can
 * say anything. Returns how many went.
 */
export function pruneAnalytics(db: Db, now = Date.now()): number {
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const requests = db
    .prepare(`DELETE FROM analytics_events WHERE kind = 'request' AND occurred_at < ?`)
    .run(daysAgo(REQUEST_LOG_DAYS)).changes;
  const guests = db
    .prepare(`DELETE FROM analytics_events WHERE kind != 'request' AND user_id IS NULL AND received_at < ?`)
    .run(daysAgo(GUEST_EVENT_DAYS)).changes;
  return Number(requests) + Number(guests);
}

/** A path under a link: the next segment is the link's token, which is all anyone needs to see the group or pay. */
const LINK_PATH = /^\/(s|g|join|links)\/[^/]+/;

/**
 * One row in analytics_events for every request answered, kind `request`:
 * the method and the route as registered (`POST /groups/:id/expenses`), with
 * the route's params, the status and how long it took in props. The
 * server's own account of what people do, beside what the app reports of
 * itself (routes/analytics.ts). It runs before auth, so a request turned
 * away is a row too, under the route it was for; who asked is known by the
 * time the answer is back. On a public route auth doesn't look, so a token
 * sent there is looked up here: a member opening their group's page in the
 * app is still them. The device and session come from the headers the app
 * sends, so a guest's requests join their screens and taps.
 *
 * A request that matched no route is `GET (no route)`, with the path it asked
 * for, cut short, in props. The API is on the open internet, and every path
 * a scanner tries would otherwise be a name of its own.
 *
 * A link's token is never kept: it's left out of the params, and out of the
 * path of a request that matched no route. Holding one is all it takes to
 * see a group or pay a debt, and the people reading this table later needn't
 * be able to.
 *
 * Left out: /health, which the app asks on every start and nobody taps, the
 * analytics route itself, and preflights. A request that threw is still a
 * row, with the status its error became: Hono answers an error where it was
 * thrown, so by the time next() is back the answer is on the context. Writing
 * the row can't fail the request: that would make a broken table cost people
 * their payments.
 *
 * Rows are written once the answer has gone, at the end of the event loop's
 * turn, all those waiting in one commit: one fsync for however many requests
 * finished meanwhile, not one each before answering. A crash loses the few
 * still waiting, which this table can spare. (PRAGMA synchronous = NORMAL
 * would make each commit cheap too, but for every table, and a power cut
 * could then lose a payment the server had already recorded.)
 */
export function requestLog(db: Db, repo: Repo): MiddlewareHandler<AppEnv> {
  const insert = db.prepare(
    `INSERT INTO analytics_events
       (id, user_id, device_id, session_id, kind, name, props, occurred_at, received_at)
     VALUES (?, ?, ?, ?, 'request', ?, ?, ?, ?)`
  );
  const header = (c: Parameters<MiddlewareHandler<AppEnv>>[0], name: string) => {
    const v = c.req.header(name)?.trim();
    return v && v.length <= ANALYTICS_LIMITS.id ? v : null;
  };
  const skipped = (path: string) => path === '/health' || path.startsWith('/analytics/');
  const who = (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => {
    const user = c.get('user');
    if (user) return user.id;
    const bearer = c.req.header('authorization');
    return (bearer?.startsWith('Bearer ') && repo.userByToken(bearer.slice(7))?.id) || null;
  };
  let waiting: (string | null)[][] = [];
  const write = () => {
    const rows = waiting;
    waiting = [];
    try {
      transaction(db, () => {
        for (const row of rows) insert.run(...row);
      });
    } catch (e) {
      console.error('request log:', e);
    }
  };

  return async (c, next) => {
    if (c.req.method === 'OPTIONS' || skipped(c.req.path)) return next();
    const started = Date.now();
    const at = nowIso();
    try {
      await next();
    } finally {
      try {
        // The route the request was for, whether or not it got that far: the last one matched
        // that isn't a middleware for every path. None means no route has that method and path.
        const route = matchedRoutes(c).findLast((r) => r.path !== '/*')?.path;
        // Only once the handler ran. A request turned away before it has none.
        const { token: _, ...params } = c.req.param() as Record<string, string>;
        const props = {
          status: c.res.status,
          ms: Date.now() - started,
          ...(Object.keys(params).length > 0 && { params }),
          ...(!route && { path: c.req.path.replace(LINK_PATH, '/$1/:token').slice(0, ANALYTICS_LIMITS.text) }),
        };
        const name = `${c.req.method} ${route ?? '(no route)'}`;
        const row = [
          newId('r'), who(c), header(c, ANALYTICS_HEADERS.device),
          header(c, ANALYTICS_HEADERS.session), name, JSON.stringify(props), at, nowIso(),
        ];
        if (waiting.push(row) === 1) setImmediate(write);
      } catch (e) {
        console.error('request log:', e);
      }
    }
  };
}
