import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';
import { describe, expect, it } from 'vitest';

import { NOSTR_AUTH_PATHS, nostrAuthTemplate, type Group, type User } from '@sattle/core';

import { createApp } from './app';
import { openDb } from './db';
import { SimulatedPayments } from './payments';

/** A production-shaped server: no fixtures, no demo user. */
function setup() {
  const db = openDb(':memory:');
  const app = createApp({
    db,
    payments: (repo) =>
      new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
  });
  async function call<T = unknown>(method: string, path: string, body?: unknown, token?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as T };
  }
  const signUp = async (displayName: string) =>
    (await call<{ user: User; token: string }>('POST', '/accounts', { displayName })).body;
  const challenge = async () => (await call<{ challenge: string }>('POST', '/auth/nostr/challenge')).body.challenge;

  /** What a signer hands back: a proof for `path`, answering a fresh challenge unless given one. */
  const prove = async (
    secret: Uint8Array,
    path: string,
    tweak: { challenge?: string; createdAt?: number; kind?: number; url?: string } = {}
  ) => {
    const template = nostrAuthTemplate(tweak.url ?? `https://api.example${path}`, tweak.challenge ?? (await challenge()), tweak.createdAt);
    if (tweak.kind) template.kind = tweak.kind;
    return finalizeEvent(template, secret);
  };
  const link = async (secret: Uint8Array, token: string) =>
    call<User>('POST', NOSTR_AUTH_PATHS.link, { event: await prove(secret, NOSTR_AUTH_PATHS.link) }, token);
  const signIn = async (secret: Uint8Array) =>
    call<{ user: User; token: string; message?: string }>('POST', NOSTR_AUTH_PATHS.signIn, {
      event: await prove(secret, NOSTR_AUTH_PATHS.signIn),
    });

  return { db, call, signUp, challenge, prove, link, signIn };
}

describe('linking a Nostr key', () => {
  it('links the key that signed the proof, and the account shows it as npub', async () => {
    const { call, signUp, link } = setup();
    const riya = await signUp('Riya');
    const secret = generateSecretKey();
    const res = await link(secret, riya.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...riya.user, npub: npubEncode(getPublicKey(secret)) });
    expect((await call<User>('GET', '/me', undefined, riya.token)).body.npub).toBe(npubEncode(getPublicKey(secret)));
  });

  it('won’t link a key another account has', async () => {
    const { signUp, link } = setup();
    const secret = generateSecretKey();
    await link(secret, (await signUp('Riya')).token);
    const res = await link(secret, (await signUp('Kabir')).token);
    expect(res.status).toBe(409);
  });

  it('replaces the linked key with a new one, and can be unlinked', async () => {
    const { call, signUp, link, signIn } = setup();
    const riya = await signUp('Riya');
    const first = generateSecretKey();
    const second = generateSecretKey();
    await link(first, riya.token);
    await link(second, riya.token);
    expect((await signIn(first)).status).toBe(404);
    expect((await signIn(second)).status).toBe(200);

    const res = await call<User>('DELETE', NOSTR_AUTH_PATHS.link, undefined, riya.token);
    expect(res.body).toEqual(riya.user);
    expect((await signIn(second)).status).toBe(404);
  });

  it('needs a sign-in', async () => {
    const { call, prove } = setup();
    const event = await prove(generateSecretKey(), NOSTR_AUTH_PATHS.link);
    expect((await call('POST', NOSTR_AUTH_PATHS.link, { event })).status).toBe(401);
  });
});

describe('POST /auth/nostr', () => {
  it('opens the linked account on a device with nothing: its groups, and the same key', async () => {
    const { call, signUp, link, signIn } = setup();
    const riya = await signUp('Riya');
    // A group only Riya has joined: nobody else could let her back in.
    await call<Group>('POST', '/groups', { name: 'Solo trip', memberNames: ['Kabir'] }, riya.token);
    const secret = generateSecretKey();
    await link(secret, riya.token);

    const res = await signIn(secret);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(riya.user.id);
    expect(res.body.token).toBe(riya.token);
    expect((await call<Group[]>('GET', '/groups', undefined, res.body.token)).body.map((g) => g.name)).toEqual(['Solo trip']);
  });

  it('gives the current key after it was replaced', async () => {
    const { call, signUp, link, signIn } = setup();
    const riya = await signUp('Riya');
    const secret = generateSecretKey();
    await link(secret, riya.token);
    const next = (await call<{ token: string }>('POST', '/me/token', undefined, riya.token)).body.token;
    expect((await signIn(secret)).body.token).toBe(next);
  });

  it('says so when no account has the key', async () => {
    const { signIn } = setup();
    const res = await signIn(generateSecretKey());
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/Link it from Account/);
  });

  it('takes each challenge once', async () => {
    const { call, signUp, link, prove, challenge } = setup();
    const secret = generateSecretKey();
    await link(secret, (await signUp('Riya')).token);
    const c = await challenge();
    const first = await prove(secret, NOSTR_AUTH_PATHS.signIn, { challenge: c });
    const second = await prove(secret, NOSTR_AUTH_PATHS.signIn, { challenge: c, createdAt: first.created_at + 1 });
    expect((await call('POST', NOSTR_AUTH_PATHS.signIn, { event: first })).status).toBe(200);
    expect((await call('POST', NOSTR_AUTH_PATHS.signIn, { event: first })).status).toBe(401);
    expect((await call('POST', NOSTR_AUTH_PATHS.signIn, { event: second })).status).toBe(401);
  });

  it('turns away a proof that doesn’t hold up, without using up its challenge', async () => {
    const { call, signUp, link, prove, challenge } = setup();
    const secret = generateSecretKey();
    await link(secret, (await signUp('Riya')).token);
    const post = (event: unknown) => call<{ message: string }>('POST', NOSTR_AUTH_PATHS.signIn, { event });
    const c = await challenge();

    // Made up, or not answering any challenge of ours.
    expect((await post(await prove(secret, NOSTR_AUTH_PATHS.signIn, { challenge: 'f'.repeat(64) }))).status).toBe(401);
    // Signed for linking, not signing in.
    expect((await post(await prove(secret, NOSTR_AUTH_PATHS.link, { challenge: c }))).body.message).toMatch(/something else/);
    // An ordinary note, or one from long ago.
    expect((await post(await prove(secret, NOSTR_AUTH_PATHS.signIn, { challenge: c, kind: 1 }))).status).toBe(401);
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect((await post(await prove(secret, NOSTR_AUTH_PATHS.signIn, { challenge: c, createdAt: old }))).status).toBe(401);
    // Changed after signing.
    const tampered = { ...(await prove(secret, NOSTR_AUTH_PATHS.signIn, { challenge: c })), content: 'x' };
    expect((await post(tampered)).status).toBe(401);
    // Not an event at all.
    expect((await post({ hello: 'world' })).status).toBe(400);

    // The challenge is still good for the real thing.
    expect((await post(await prove(secret, NOSTR_AUTH_PATHS.signIn, { challenge: c }))).status).toBe(200);
  });

  it('checks the path the proof names, not the host, which a proxy may change', async () => {
    const { call, signUp, link, prove } = setup();
    const secret = generateSecretKey();
    await link(secret, (await signUp('Riya')).token);
    const event = await prove(secret, NOSTR_AUTH_PATHS.signIn, { url: 'http://localhost:3001/auth/nostr' });
    expect((await call('POST', NOSTR_AUTH_PATHS.signIn, { event })).status).toBe(200);
  });

  it('turns away an expired challenge', async () => {
    const { db, call, signUp, link, prove, challenge } = setup();
    const secret = generateSecretKey();
    await link(secret, (await signUp('Riya')).token);
    const c = await challenge();
    db.prepare('UPDATE nostr_challenges SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
    const event = await prove(secret, NOSTR_AUTH_PATHS.signIn, { challenge: c });
    expect((await call('POST', NOSTR_AUTH_PATHS.signIn, { event })).status).toBe(401);
  });
});
