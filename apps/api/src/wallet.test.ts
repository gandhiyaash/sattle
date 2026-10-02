import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Member, WalletConnection } from '@sattle/core';

import { createApp } from './app';
import { openDb, seedIfEmpty, type Db } from './db';
import { NwcError, type NwcApi, type NwcInfo } from './nwc';
import { SimulatedPayments } from './payments';

const PK = 'a'.repeat(64);
const SECRET = 'c0ffee'.repeat(10) + 'beef';
const URI = `nostr+walletconnect://${PK}?relay=wss://relay.example&secret=${SECRET}`;

let db: Db;
let info: NwcInfo | Error;
let opened: string[];
let logged: string[];

function fakeNwc(uri: string): NwcApi {
  opened.push(uri);
  return {
    getInfo: async () => {
      if (info instanceof Error) throw info;
      return info;
    },
    makeInvoice: async () => {
      throw new Error('not used here');
    },
    lookupInvoice: async () => {
      throw new Error('not used here');
    },
    close: () => {},
  };
}

function app() {
  return createApp({
    db,
    demoUserId: 'u-yash',
    nwc: fakeNwc,
    payments: (repo) =>
      new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
  });
}

async function call<T = unknown>(method: string, path: string, body?: unknown) {
  const res = await app().request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  expect(text).not.toContain(SECRET);
  return { status: res.status, body: JSON.parse(text) as T };
}

beforeEach(() => {
  db = openDb(':memory:');
  seedIfEmpty(db);
  info = { alias: 'Test Hub', methods: ['get_info', 'make_invoice', 'lookup_invoice'] };
  opened = [];
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args) => void logged.push(args.map(String).join(' ')));
  }
});

afterEach(() => {
  expect(logged.join('\n')).not.toContain(SECRET);
  vi.restoreAllMocks();
});

describe('PUT /me/wallet', () => {
  it('connects a receive-only wallet and links every member the user has claimed', async () => {
    const res = await call<WalletConnection>('PUT', '/me/wallet', { nwcUri: URI });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      connected: true,
      methods: ['get_info', 'make_invoice', 'lookup_invoice'],
      excessMethods: [],
      alias: 'Test Hub',
    });
    expect(opened).toEqual([URI]);

    const mine = db.prepare(`SELECT status FROM members WHERE claimed_by_user_id = 'u-yash'`).all() as Pick<Member, 'status'>[];
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((m) => m.status === 'nwc_linked')).toBe(true);
    const others = db.prepare(`SELECT status FROM members WHERE claimed_by_user_id = 'u-om'`).all() as Pick<Member, 'status'>[];
    expect(others.some((m) => m.status !== 'nwc_linked')).toBe(true);
  });

  it('flags pay_invoice and anything else the server does not need', async () => {
    info = { methods: ['get_info', 'make_invoice', 'lookup_invoice', 'pay_invoice', 'get_balance'] };
    const res = await call<WalletConnection>('PUT', '/me/wallet', { nwcUri: URI });
    expect(res.status).toBe(200);
    expect(res.body.excessMethods).toEqual(['pay_invoice', 'get_balance']);
  });

  it('refuses a connection that cannot receive', async () => {
    info = { methods: ['get_info', 'pay_invoice'] };
    const res = await call('PUT', '/me/wallet', { nwcUri: URI });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'invalid_wallet' });
    expect((await call<WalletConnection>('GET', '/me/wallet')).body.connected).toBe(false);
  });

  it('refuses a string that is not an NWC connection, before contacting anything', async () => {
    for (const nwcUri of ['https://not-nwc', `nostr+walletconnect://${PK}?relay=wss://r`]) {
      const res = await call('PUT', '/me/wallet', { nwcUri });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_wallet' });
    }
    expect(opened).toEqual([]);
  });

  it('says the wallet is unreachable when it times out', async () => {
    info = new NwcError('TIMEOUT', 'The wallet didn’t answer get_info in time.');
    const res = await call('PUT', '/me/wallet', { nwcUri: URI });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'network' });
  });

  it('passes on a wallet refusal as invalid_wallet', async () => {
    info = new NwcError('UNAUTHORIZED', 'no wallet connected');
    const res = await call('PUT', '/me/wallet', { nwcUri: URI });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'invalid_wallet' });
  });

  it('logs a crash without the string', async () => {
    info = new Error(`boom ${URI}`);
    const res = await call('PUT', '/me/wallet', { nwcUri: URI });
    expect(res.status).toBe(500);
    expect(logged.length).toBeGreaterThan(0);
  });

  it('replaces an earlier connection', async () => {
    await call('PUT', '/me/wallet', { nwcUri: URI });
    info = { alias: 'Second', methods: ['get_info', 'make_invoice', 'lookup_invoice'] };
    await call('PUT', '/me/wallet', { nwcUri: URI });
    expect((await call<WalletConnection>('GET', '/me/wallet')).body.alias).toBe('Second');
    expect(db.prepare('SELECT COUNT(*) AS n FROM wallet_connections').get()).toEqual({ n: 1 });
  });
});

describe('GET /me/wallet', () => {
  it('says not connected when there is nothing', async () => {
    const res = await call('GET', '/me/wallet');
    expect(res).toEqual({ status: 200, body: { connected: false, methods: [], excessMethods: [] } });
  });

  it('returns the connection without the string', async () => {
    await call('PUT', '/me/wallet', { nwcUri: URI });
    const res = await call<WalletConnection>('GET', '/me/wallet');
    expect(res.body).toMatchObject({ connected: true, alias: 'Test Hub' });
    expect(Object.keys(res.body).sort()).toEqual(['alias', 'connected', 'connectedAt', 'excessMethods', 'methods']);
  });
});
