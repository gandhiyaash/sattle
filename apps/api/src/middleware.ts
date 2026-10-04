import type { MiddlewareHandler } from 'hono';

import { SattleError, type User } from '@sattle/core';

import type { AppEnv } from './context';
import type { Db } from './db';
import { nowIso, type Repo } from './repo';

/**
 * Reachable without signing in: the guest pay page under /s/, reading an
 * invite under /join/, and making an account. Accepting an invite is not
 * here: that needs an account, so it lives at POST /groups/join.
 */
const PUBLIC_PREFIXES = ['/health', '/s/', '/join/', '/accounts'];

export const isPublic = (path: string) => PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p));

export function auth(repo: Repo, demoUserId?: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS' || isPublic(c.req.path)) return next();
    const header = c.req.header('authorization');
    let user: User | undefined;
    if (header?.startsWith('Bearer ')) {
      user = repo.userByToken(header.slice(7));
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
