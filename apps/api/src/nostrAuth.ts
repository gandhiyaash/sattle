/**
 * Checking a Nostr sign-in proof (see @sattle/core nostrAuth): a signed
 * HTTP-auth event that answers one of our challenges, for the route it was
 * sent to. What's checked, in order:
 *
 *   shape      an event, with an id, pubkey and signature
 *   signature  the id is the event's hash and the pubkey signed it
 *   kind       27235, HTTP auth, not some other note someone signed
 *   time       made within the last few minutes, not long ago or ahead
 *   u, method  a POST to this path, so a proof for linking can't sign in
 *   challenge  one we handed out, unused and unexpired; it's used up here
 *
 * The challenge is checked last so that something that fails the others
 * doesn't use it up. Answers the key, as hex.
 */

import { randomBytes } from 'node:crypto';

import type { Event } from 'nostr-tools';
import { verifyEvent } from 'nostr-tools/pure';
import { z } from 'zod';

import { NOSTR_AUTH_KIND, SattleError } from '@sattle/core';

import type { Repo } from './repo';

/** How long a challenge is good for. Long enough to approve on a phone, no longer. */
export const CHALLENGE_MS = 5 * 60_000;
/** How far an event's time may be from ours. */
const MAX_SKEW_S = 5 * 60;
/** Challenges are free to ask for; this keeps a flood of them from filling the database. */
const MAX_LIVE_CHALLENGES = 5_000;

const HEX64 = /^[0-9a-f]{64}$/;
const EventShape = z.object({
  id: z.string().regex(HEX64),
  pubkey: z.string().regex(HEX64),
  sig: z.string().regex(/^[0-9a-f]{128}$/),
  kind: z.number().int(),
  created_at: z.number().int(),
  tags: z.array(z.array(z.string())),
  content: z.string(),
});

const refuse = (message: string) => new SattleError('unauthorized', message);

/** A new challenge, for the app to have signed. */
export function newChallenge(repo: Repo): { challenge: string; expiresAt: string } {
  const challenge = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + CHALLENGE_MS).toISOString();
  if (repo.addChallenge(challenge, expiresAt) > MAX_LIVE_CHALLENGES) {
    repo.takeChallenge(challenge);
    throw new SattleError('conflict', 'Too many people are signing in right now. Try again in a minute.');
  }
  return { challenge, expiresAt };
}

/** The key that signed a proof sent to `path`, as hex. Throws `unauthorized` saying what was wrong. */
export function checkNostrProof(repo: Repo, raw: unknown, path: string): string {
  const parsed = EventShape.safeParse(raw);
  if (!parsed.success) throw new SattleError('invalid_input', 'That isn’t a signed Nostr event.');
  const event = parsed.data as Event;
  if (!verifyEvent(event)) throw refuse('The signature on that doesn’t check out.');
  if (event.kind !== NOSTR_AUTH_KIND) throw refuse('Your signer signed the wrong kind of event.');
  if (Math.abs(event.created_at - Date.now() / 1000) > MAX_SKEW_S) {
    throw refuse('That was signed too long ago, or the clock on this device is off. Try again.');
  }

  const tag = (name: string) => event.tags.find((t) => t[0] === name)?.[1];
  let signedPath: string | undefined;
  try {
    signedPath = new URL(tag('u') ?? '').pathname;
  } catch {
    signedPath = undefined;
  }
  if (signedPath !== path || tag('method') !== 'POST') throw refuse('That was signed for something else.');

  const challenge = tag('challenge');
  if (!challenge || !repo.takeChallenge(challenge)) throw refuse('That sign-in has expired or was already used. Try again.');
  return event.pubkey;
}
