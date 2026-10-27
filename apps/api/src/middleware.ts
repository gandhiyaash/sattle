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
/** How long anything else the app reported is kept: an account's, and what its install did before signing in. */
export const ACCOUNT_EVENT_DAYS = 365;

/**
 * Drops request rows older than REQUEST_LOG_DAYS, what the app reported
 * without an account older than GUEST_EVENT_DAYS, and everything else the
 * app reported older than ACCOUNT_EVENT_DAYS; server.ts runs it on start and
 * daily. A screen that keeps itself current (a group, every 4 s while it
 * shows) asks about 900 times an hour, so without this the request log
 * would outgrow everything else on the disk. Guest rows are the ones anyone
 * can post, so they go soonest, except from an install that has since been
 * signed in: what someone did before making an account is theirs
 * afterwards, and is kept like the rest of theirs. That is kept longest,
 * since it's what a statistics page counts, but not for ever: anyone can
 * make an account, so the daily cap bounds how fast the table grows, and
 * this how big.
 *
 * All go by when the server took them (received_at, which the table's one
 * index is on), since a device's clock can say anything. A month of request
 * rows for one group left open is hundreds of thousands, so they go
 * PRUNE_CHUNK at a time, each its own short commit, with a turn of the event
 * loop between for requests waiting. The installs that have been signed in
 * are listed once, up front, rather than looked for again in every chunk.
 * Resolves to how many went.
 */
export async function pruneAnalytics(db: Db, now = Date.now()): Promise<number> {
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
  db.exec('CREATE TEMP TABLE IF NOT EXISTS signed_in_devices (device_id TEXT PRIMARY KEY)');
  try {
    db.exec(`DELETE FROM temp.signed_in_devices;
      INSERT OR IGNORE INTO temp.signed_in_devices
        SELECT device_id FROM analytics_events WHERE user_id IS NOT NULL AND device_id IS NOT NULL`);
    const chunk = (where: string) =>
      db.prepare(
        `DELETE FROM analytics_events WHERE rowid IN (
           SELECT rowid FROM analytics_events WHERE received_at < ? AND ${where} LIMIT ${PRUNE_CHUNK}
         )`
      );
    const passes = [
      [chunk(`kind = 'request'`), daysAgo(REQUEST_LOG_DAYS)],
      [
        chunk(`kind != 'request' AND user_id IS NULL
               AND (device_id IS NULL OR device_id NOT IN (SELECT device_id FROM temp.signed_in_devices))`),
        daysAgo(GUEST_EVENT_DAYS),
      ],
      [chunk(`kind != 'request'`), daysAgo(ACCOUNT_EVENT_DAYS)],
    ] as const;
    let gone = 0;
    for (const [stmt, before] of passes) {
      for (;;) {
        const n = Number(stmt.run(before).changes);
        gone += n;
        if (n < PRUNE_CHUNK) break;
        await new Promise((r) => setImmediate(r));
      }
    }
    return gone;
  } finally {
    db.exec('DROP TABLE IF EXISTS temp.signed_in_devices');
  }
}

/** Rows pruneAnalytics deletes in one go. */
const PRUNE_CHUNK = 5000;

/** Where an account is deleted (DELETE, in routes/accounts.ts). */
const ACCOUNT_PATH = '/me';

/** How long requestLog remembers which account a token on a public route named, and for how many tokens at most. */
const TOKEN_MEMORY_MS = 60_000;
const TOKENS_REMEMBERED = 1000;

/** A path under a link: the next segment is the link's token, which is all anyone needs to see the group or pay. */
const LINK_PATH = /^\/(s|g|join|links)\/[^/]+/;

/**
 * Off unless AppDeps.requestLog is set (REQUEST_LOG=true in server.ts): with
 * it on, every route is a write to the disk the settlements are on, and a
 * client faking the app's device header can still write a lot, so its
 * limits want more thought before it runs in production.
 *
 * One row in analytics_events for every request answered that names an
 * account or comes from the app (its device header), kind `request`:
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
 * A request with neither leaves no row. The API is on the open internet,
 * and nothing limits how often a scanner may ask, so its requests would be
 * an uncapped write to the disk every settlement is on. The app's own
 * requests, the ones turned away included, carry its device header once it
 * has read its install id, a moment after starting. A client that makes up
 * a device header is still kept: this keeps out traffic that isn't aimed at
 * Sattle, not traffic that is.
 *
 * A request that matched no route is `GET (no route)`, with the path it asked
 * for, cut short, in props, so a client trying many paths doesn't make a
 * name of each.
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
 * Its times are the wall clock's, not nowIso's, which moves a millisecond
 * ahead each time it's called faster than that, so that links and
 * settlements order right: two calls for every request would push it ahead
 * of the real time under load.
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
  // On a public route auth doesn't look the token up, so this does. A screen kept current asks
  // every few seconds with the same token, so what it named is remembered for a minute rather
  // than read from users each time. A token replaced or an account deleted in that minute is
  // still named in a row or two of the log, which is all this is for.
  const named = new Map<string, { id: string | null; until: number }>();
  const who = (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => {
    const user = c.get('user');
    if (user) return user.id;
    const bearer = c.req.header('authorization');
    if (!bearer?.startsWith('Bearer ')) return null;
    const token = bearer.slice(7);
    const now = Date.now();
    const known = named.get(token);
    if (known && known.until > now) return known.id;
    // Made-up tokens are remembered too, so the map is kept small rather than grown by them.
    if (named.size >= TOKENS_REMEMBERED) named.clear();
    const id = repo.userByToken(token)?.id ?? null;
    named.set(token, { id, until: now + TOKEN_MEMORY_MS });
    return id;
  };

  let waiting: (string | null)[][] = [];
  /** An account just deleted: its rows still waiting go too, and its token names nobody now. */
  const forget = (id: string | undefined) => {
    if (!id) return;
    waiting = waiting.filter((row) => row[1] !== id);
    for (const [token, known] of named) if (known.id === id) named.delete(token);
  };
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
    const at = new Date().toISOString();
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
        // The account was just deleted, its usage record with it (repo.deleteUser): this row
        // mustn't put it back, and its token mustn't name it here again.
        const deleted = c.req.method === 'DELETE' && route === ACCOUNT_PATH && c.res.ok;
        if (deleted) forget(c.get('user')?.id);
        const user = deleted ? null : who(c);
        const device = header(c, ANALYTICS_HEADERS.device);
        // Neither an account nor the app: a scanner or a script, with nothing to join it to, and
        // free to send as many as it likes. Kept, it would be an uncapped write to the disk the
        // settlements are on.
        if (user || device) {
          const row = [
            newId('r'), user, device, header(c, ANALYTICS_HEADERS.session),
            name, JSON.stringify(props), at, new Date().toISOString(),
          ];
          if (waiting.push(row) === 1) setImmediate(write);
        }
      } catch (e) {
        console.error('request log:', e);
      }
    }
  };
}
