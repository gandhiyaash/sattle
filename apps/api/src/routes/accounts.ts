import { randomBytes } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv, Ctx } from '../context';
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
export function accountRoutes({ repo }: Ctx) {
  const r = new Hono<AppEnv>();

  r.post('/accounts', async (c) => {
    const { displayName } = parse(AccountBody, await c.req.json());
    const token = randomBytes(32).toString('base64url');
    const user = repo.insertUser({ id: newId('u'), displayName }, token);
    return c.json({ user, token }, 201);
  });

  return r;
}
