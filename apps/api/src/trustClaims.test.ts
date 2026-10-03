/**
 * Each test pins a sentence on the app's trust screen (TrustModel in
 * apps/mobile/src/ui/WalletScreen.tsx). If one fails, the code changed what
 * a user is trusting: rewrite the sentence first, then this test.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Debt, Settlement, User } from '@sattle/core';

import { createApp } from './app';
import { openDb, seedIfEmpty } from './db';
import type { NwcApi } from './nwc';
import { SimulatedPayments } from './payments';

const URI = `nostr+walletconnect://${'a'.repeat(64)}?relay=wss://relay.example&secret=${'b'.repeat(64)}`;

const receiveOnly = (): NwcApi => ({
  getInfo: async () => ({ alias: 'Test Hub', methods: ['get_info', 'make_invoice', 'lookup_invoice'] }),
  makeInvoice: async () => {
    throw new Error('not used here');
  },
  lookupInvoice: async () => {
    throw new Error('not used here');
  },
  close: () => {},
});

function setup() {
  const db = openDb(':memory:');
  seedIfEmpty(db);
  const app = createApp({
    db,
    demoUserId: 'u-yash',
    nwc: receiveOnly,
    payments: (repo) =>
      new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
  });
  async function call<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
  }
  return { db, call };
}

const source = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

describe('Your wallet connection', () => {
  it('"It asks only three things": every request the client sends is one of them', () => {
    const sent = [...source('./nwc.ts').matchAll(/this\.#request<[^(]*\('([a-z_]+)'/g)].map((m) => m[1]);
    expect(sent.sort()).toEqual(['get_info', 'lookup_invoice', 'make_invoice']);
  });

  it('"It has no code that spends": nothing that talks to a wallet names a paying method', () => {
    for (const file of ['./nwc.ts', './payments/nwc.ts', './routes/wallet.ts']) {
      expect(source(file)).not.toMatch(/pay_invoice|pay_keysend/);
    }
  });

  it('"keeps the connection string, unencrypted"', async () => {
    const { db, call } = setup();
    expect((await call('PUT', '/me/wallet', { nwcUri: URI })).status).toBe(200);
    const row = db.prepare('SELECT nwc_uri FROM wallet_connections').get() as { nwc_uri: string };
    expect(row.nwc_uri).toBe(URI);
  });

  it('"There is no disconnect button yet": the server has no route to remove one', async () => {
    const { call } = setup();
    await call('PUT', '/me/wallet', { nwcUri: URI });
    expect((await call('DELETE', '/me/wallet')).status).toBe(404);
  });
});

describe('Your account', () => {
  it('"a name and a random key": that is all an account is made from', async () => {
    const { call } = setup();
    const res = await call<{ user: User; token: string }>('POST', '/accounts', {
      displayName: 'Riya',
      email: 'riya@example.com',
      phone: '+910000000000',
    });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body.user).sort()).toEqual(['displayName', 'id']);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await call<User>('GET', '/me', undefined, { authorization: `Bearer ${res.body.token}` })).body).toEqual(
      res.body.user
    );
  });
});

describe('Is it really paid?', () => {
  it('"any member of a group can mark a debt that way": Om settles Priya’s debt to Yash by hand', async () => {
    const { db, call } = setup();
    db.prepare("UPDATE users SET token = 't-om' WHERE id = 'u-om'").run();
    const asOm = { authorization: 'Bearer t-om' };

    const debt = (await call<Debt[]>('GET', '/groups/g-flat/debts', undefined, asOm)).body.find(
      (d) => d.fromMemberId === 'm-flat-priya' && d.toMemberId === 'm-flat-yash'
    )!;
    const res = await call<Settlement>(
      'POST',
      '/groups/g-flat/settlements/manual',
      { fromMemberId: debt.fromMemberId, toMemberId: debt.toMemberId, amount: debt.amount, note: 'cash' },
      asOm
    );
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('manually_confirmed');
    expect(res.body).not.toHaveProperty('preimage');
  });
});
