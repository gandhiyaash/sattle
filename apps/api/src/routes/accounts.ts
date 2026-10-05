import { randomBytes } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import { NOSTR_AUTH_PATHS, SattleError } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { transaction } from '../db';
import { deleteAccount } from '../groupRules';
import { parse } from '../http';
import { REPLACE_KEY_PATH, idempotency } from '../middleware';
import { checkNostrProof, newChallenge } from '../nostrAuth';
import { newId } from '../repo';

const AccountBody = z.object({ displayName: z.string().trim().min(1).max(40) });
/** A signed Nostr event, checked by checkNostrProof. */
const ProofBody = z.object({ event: z.unknown() });

/**
 * Device accounts. A name in, a bearer token out; no email, phone or
 * password. The app keeps the token on the device and can show it as a
 * sign-in key, which is how the account gets onto another device. Losing
 * every device that has it loses the account. Making one is public, since
 * there's nobody to be signed in as yet.
 *
 * No idempotency key: replays are keyed on 'guest' for public routes, and a
 * replayed response here would hand someone else's token to whoever repeats
 * the key. A retry makes a second, empty account, which is harmless.
 */
export function accountRoutes({ db, repo, wallets }: Ctx) {
  const r = new Hono<AppEnv>();
  const once = idempotency(db);

  r.post('/accounts', async (c) => {
    const { displayName } = parse(AccountBody, await c.req.json());
    const token = randomBytes(32).toString('base64url');
    const user = repo.insertUser({ id: newId('u'), displayName }, token);
    return c.json({ user, token }, 201);
  });

  /**
   * A new sign-in key for the caller: `{ token }`. The old one stops working
   * at once, on every device that has it, so this is what to do about a key
   * that may have leaked. The device asking keeps going with the new one.
   *
   * Idempotent, and that matters more than usual: a device whose answer was
   * lost still holds the old key, which no longer signs in. So the old key is
   * let through to this route alone, for PREVIOUS_TOKEN_MS (see auth), where
   * a retry with the same idempotency key gets the stored answer replayed. A
   * new request with it gets 401, so the old key can't mint a new one.
   */
  r.post(REPLACE_KEY_PATH, once, (c) => {
    if (c.get('replacedKey')) throw new SattleError('unauthorized', 'This sign-in key was replaced. Sign in with the new one.');
    const token = randomBytes(32).toString('base64url');
    repo.replaceToken(c.get('user').id, token);
    return c.json({ token });
  });

  /**
   * Public. A one-time challenge for a Nostr sign-in proof: `{ challenge,
   * expiresAt }`. The same for signing in and for linking a key.
   */
  r.post('/auth/nostr/challenge', (c) => c.json(newChallenge(repo)));

  /**
   * Public. Signs in with Nostr: a proof (see nostrAuth.ts) from a key linked
   * to an account answers `{ user, token }`, that account's sign-in key, the
   * same as pasting it. This is how someone gets back in with neither their
   * device nor their sign-in key, including to a group nobody else joined.
   *
   * No idempotency key: replays on public routes are keyed on 'guest', and
   * would hand the token to whoever repeated the key. A retry asks for a new
   * challenge and signs again.
   *   not a signed event                    → 400 invalid_input
   *   proof doesn't hold up                 → 401 unauthorized
   *   no account has that key linked        → 404 not_found
   */
  r.post(NOSTR_AUTH_PATHS.signIn, async (c) => {
    const { event } = parse(ProofBody, await c.req.json());
    const pubkey = checkNostrProof(repo, event, NOSTR_AUTH_PATHS.signIn);
    const user = repo.userByNostr(pubkey);
    if (!user) {
      throw new SattleError(
        'not_found',
        'No Sattle account has this Nostr key. Link it from Account on a device where you’re signed in.'
      );
    }
    return c.json({ user, token: repo.tokenOf(user.id) });
  });

  /**
   * Links a Nostr key to the caller's account, with a proof signed by it, and
   * answers the User with its npub. Linking another replaces it.
   *   proof doesn't hold up                 → 401 unauthorized
   *   another account has that key          → 409 conflict
   */
  r.post(NOSTR_AUTH_PATHS.link, async (c) => {
    const user = c.get('user');
    const { event } = parse(ProofBody, await c.req.json());
    const linked = transaction(db, () => {
      const pubkey = checkNostrProof(repo, event, NOSTR_AUTH_PATHS.link);
      const other = repo.userByNostr(pubkey);
      if (other && other.id !== user.id) {
        throw new SattleError('conflict', 'That Nostr key is linked to another Sattle account. Unlink it there first.');
      }
      repo.setNostr(user.id, pubkey);
      return repo.userById(user.id)!;
    });
    return c.json(linked);
  });

  /** Unlinks the caller's Nostr key, and answers the User. Signing in with it stops working. */
  r.delete(NOSTR_AUTH_PATHS.link, (c) => {
    const user = c.get('user');
    repo.setNostr(user.id, null);
    return c.json(repo.userById(user.id)!);
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
