import { randomBytes } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv, Ctx } from '../context';
import { transaction } from '../db';
import { deleteAccount } from '../groupRules';
import { parse } from '../http';
import { newId } from '../repo';

const AccountBody = z.object({ displayName: z.string().trim().min(1).max(40) });

/**
 * Device accounts. A name in, a bearer token out; no email, phone or
 * password. The app keeps the token on the device, so losing the device
 * loses the account. Public, since there's nobody to be signed in as yet.
 *
 * No idempotency key: replays are keyed on 'guest' for public routes, and a
 * replayed response here would hand someone else's token to whoever repeats
 * the key. A retry makes a second, empty account, which is harmless.
 */
export function accountRoutes({ db, repo, wallets }: Ctx) {
  const r = new Hono<AppEnv>();

  r.post('/accounts', async (c) => {
    const { displayName } = parse(AccountBody, await c.req.json());
    const token = randomBytes(32).toString('base64url');
    const user = repo.insertUser({ id: newId('u'), displayName }, token);
    return c.json({ user, token }, 201);
  });

  /**
   * Deletes the caller's account. Authed: /me isn't under a public prefix.
   * Their token stops working, their wallet connection is forgotten, and the
   * pay links they made and their requests to join are removed. In each group their member
   * becomes a ghost, with its name and balance, because the others' ledger
   * still needs that row; a group where they were the only account is
   * deleted outright. 409 while a payment to them is under way.
   *
   * No idempotency key, for the same reason there is no account to key on
   * afterwards: a retry gets 401, which the app reads as done.
   */
  r.delete('/me', (c) => {
    const user = c.get('user');
    transaction(db, () => deleteAccount(repo, wallets, user));
    return c.json({ ok: true });
  });

  return r;
}
