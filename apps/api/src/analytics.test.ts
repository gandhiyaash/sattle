/**
 * POST /analytics/events, and the request log beside it: what the app
 * reports of itself and what the server sees it do, both in analytics_events.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { ANALYTICS_HEADERS, ANALYTICS_LIMITS, type AnalyticsBatch, type User } from '@sattle/core';

import { createApp } from './app';
import { openDb, type Db } from './db';
import { ACCOUNT_EVENT_DAYS, GUEST_EVENT_DAYS, REQUEST_LOG_DAYS, pruneAnalytics } from './middleware';
import { SimulatedPayments } from './payments';
import { sharer } from './routes/analytics';

let db: Db;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(':memory:');
  // The request log is off unless asked for; these tests cover it, so they ask.
  app = createApp({
    db,
    payments: (repo) =>
      new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
    requestLog: true,
  });
});

async function call<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

const signUp = async (displayName: string) =>
  (await call<{ user: User; token: string }>('POST', '/accounts', { displayName })).body;

type Row = {
  id: string;
  user_id: string | null;
  device_id: string | null;
  session_id: string | null;
  seq: number | null;
  kind: string;
  name: string;
  screen: string | null;
  props: string | null;
  platform: string | null;
  app_version: string | null;
  occurred_at: string;
  received_at: string;
};

/** In the order they were written. */
const rows = (kind?: string) =>
  db.prepare(`SELECT * FROM analytics_events ${kind ? `WHERE kind = '${kind}'` : ''} ORDER BY rowid`).all() as Row[];

const DAY = 86_400_000;

/** The request log writes at the end of the event loop's turn (see requestLog). */
const written = () => new Promise((r) => setImmediate(r));

const batch = (over: Partial<AnalyticsBatch> = {}): AnalyticsBatch => ({
  deviceId: 'dev-1',
  platform: 'android',
  appVersion: '1.2.0',
  events: [
    { id: 'e1', sessionId: 's1', seq: 0, kind: 'app', name: 'open', at: '2026-10-27T10:00:00.000Z' },
    { id: 'e2', sessionId: 's1', seq: 1, kind: 'screen', name: 'Groups', at: '2026-10-27T10:00:01.000Z' },
    {
      id: 'e3', sessionId: 's1', seq: 2, kind: 'tap', name: 'New group', screen: 'Groups',
      props: { control: 'button' }, at: '2026-10-27T10:00:02.000Z',
    },
  ],
  ...over,
});

describe('POST /analytics/events, past the day’s budget', () => {
  const one = () => Buffer.byteLength(JSON.stringify(batch()));
  /** Room for one and a half batch() a day, in all and from the one address the tests post from. */
  const capped = () => {
    app = createApp({
      db,
      payments: (repo) =>
        new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
      analyticsDailyBytes: Math.floor(one() * 1.5),
      analyticsAddressDailyBytes: Math.floor(one() * 1.5),
    });
  };
  const another = (prefix: string) => batch({ events: batch().events.map((e) => ({ ...e, id: `${prefix}-${e.id}` })) });
  const from = (address: string) => ({ 'x-real-ip': address });

  it('takes no more once the day’s bytes are used, keeping nothing of the batch it turned away', async () => {
    capped();
    expect((await call('POST', '/analytics/events', batch())).status).toBe(202);
    const res = await call<{ code: string }>('POST', '/analytics/events', another('b'));
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('conflict');
    expect(rows().map((r) => r.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('counts only batches it keeps, so a refused one uses none of the day', async () => {
    capped();
    expect((await call('POST', '/analytics/events', { ...batch(), platform: 'fridge' })).status).toBe(400);
    expect((await call('POST', '/analytics/events', batch())).status).toBe(202);
  });

  it('charges nothing for a batch sent again whose events it already has', async () => {
    capped();
    expect((await call('POST', '/analytics/events', batch())).status).toBe(202);
    // The answer was lost, so the app sends the same ids again, twice.
    for (let i = 0; i < 2; i++) {
      const again = await call<{ accepted: number }>('POST', '/analytics/events', batch());
      expect(again).toEqual({ status: 202, body: { accepted: 0 } });
    }
    // Only the first used the day: a new batch is still past the room left.
    expect((await call('POST', '/analytics/events', another('b'))).status).toBe(429);
  });

  it('gives one address only its share, so other phones are still taken', async () => {
    // Room for three in all; one address may use one and a half.
    app = createApp({
      db,
      payments: (repo) =>
        new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
      analyticsDailyBytes: one() * 3,
      analyticsAddressDailyBytes: Math.floor(one() * 1.5),
    });
    expect((await call('POST', '/analytics/events', batch(), from('203.0.113.7'))).status).toBe(202);
    expect((await call('POST', '/analytics/events', another('b'), from('203.0.113.7'))).status).toBe(429);
    expect((await call('POST', '/analytics/events', another('c'), from('198.51.100.4'))).status).toBe(202);
  });

  it('gives an IPv6 /64 one share, however many of its addresses post', async () => {
    app = createApp({
      db,
      payments: (repo) =>
        new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
      analyticsDailyBytes: one() * 3,
      analyticsAddressDailyBytes: Math.floor(one() * 1.5),
    });
    expect((await call('POST', '/analytics/events', batch(), from('2001:db8:1:2::a'))).status).toBe(202);
    expect((await call('POST', '/analytics/events', another('b'), from('2001:db8:1:2:ffff::b'))).status).toBe(429);
    expect((await call('POST', '/analytics/events', another('c'), from('2001:db8:1:3::a'))).status).toBe(202);
  });
});

describe('sharer', () => {
  it('takes an IPv6 address to its /64, however it is written', () => {
    for (const a of ['2001:db8:0:2::1', '2001:0DB8:0000:0002:aaaa:bbbb:cccc:dddd', '2001:db8:0:2:1:2:192.0.2.1', '2001:db8:0:2::1%eth0']) {
      expect(sharer(a)).toBe('2001:db8:0:2::/64');
    }
    expect(sharer('::1')).toBe('0:0:0:0::/64');
    expect(sharer('2001:db8::')).toBe('2001:db8:0:0::/64');
  });

  it('keeps an IPv4 address, mapped or not, and anything else, as it is', () => {
    expect(sharer('203.0.113.7')).toBe('203.0.113.7');
    expect(sharer('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(sharer('')).toBe('');
    expect(sharer('not an address')).toBe('not an address');
  });
});

describe('POST /analytics/events', () => {
  it('keeps a guest’s batch, with no account on it', async () => {
    const { status, body } = await call<{ accepted: number }>('POST', '/analytics/events', batch());
    expect(status).toBe(202);
    expect(body).toEqual({ accepted: 3 });

    const kept = rows().filter((r) => r.kind !== 'request');
    expect(kept.map((r) => [r.id, r.kind, r.name, r.screen, r.seq])).toEqual([
      ['e1', 'app', 'open', null, 0],
      ['e2', 'screen', 'Groups', null, 1],
      ['e3', 'tap', 'New group', 'Groups', 2],
    ]);
    for (const r of kept) {
      expect(r.user_id).toBeNull();
      expect(r.device_id).toBe('dev-1');
      expect(r.session_id).toBe('s1');
      expect(r.platform).toBe('android');
      expect(r.app_version).toBe('1.2.0');
      expect(Date.parse(r.received_at)).toBeGreaterThan(0);
    }
    expect(kept[0].occurred_at).toBe('2026-10-27T10:00:00.000Z');
    expect(JSON.parse(kept[2].props!)).toEqual({ control: 'button' });
    expect(kept[0].props).toBeNull();
  });

  it('names the account when a live token comes with it, and nobody for a dead one', async () => {
    const riya = await signUp('Riya');
    await call('POST', '/analytics/events', batch(), { authorization: `Bearer ${riya.token}` });
    expect(rows('screen')[0].user_id).toBe(riya.user.id);

    await call('DELETE', '/me', undefined, { authorization: `Bearer ${riya.token}` });
    const { status } = await call(
      'POST', '/analytics/events',
      batch({ events: [{ id: 'e9', sessionId: 's2', seq: 0, kind: 'screen', name: 'Welcome', at: '2026-10-27T11:00:00.000Z' }] }),
      { authorization: `Bearer ${riya.token}` }
    );
    expect(status).toBe(202);
    expect(rows('screen').find((r) => r.id === 'e9')!.user_id).toBeNull();
  });

  it('keeps a batch sent twice once', async () => {
    await call('POST', '/analytics/events', batch());
    const { body } = await call<{ accepted: number }>('POST', '/analytics/events', batch());
    expect(body).toEqual({ accepted: 0 });
    expect(rows('screen')).toHaveLength(1);
  });

  it('takes a time it can’t read as now', async () => {
    const before = Date.now();
    await call('POST', '/analytics/events', batch({
      events: [{ id: 'e1', sessionId: 's1', seq: 0, kind: 'screen', name: 'Groups', at: 'yesterday-ish' }],
    }));
    expect(Date.parse(rows('screen')[0].occurred_at)).toBeGreaterThanOrEqual(before);
  });

  it('refuses a batch over the limits, whole', async () => {
    const event = (id: string) => ({ id, sessionId: 's1', seq: 0, kind: 'tap' as const, name: 'x', at: '2026-10-27T10:00:00.000Z' });
    const tooMany = Array.from({ length: ANALYTICS_LIMITS.eventsPerBatch + 1 }, (_, i) => event(`e${i}`));
    expect((await call('POST', '/analytics/events', batch({ events: tooMany }))).status).toBe(400);
    expect((await call('POST', '/analytics/events', batch({ events: [] }))).status).toBe(400);
    expect(
      (await call('POST', '/analytics/events', batch({ events: [{ ...event('e1'), name: 'n'.repeat(ANALYTICS_LIMITS.text + 1) }] }))).status
    ).toBe(400);
    expect(
      (await call('POST', '/analytics/events', batch({
        events: [{ ...event('e1'), props: { big: 'p'.repeat(ANALYTICS_LIMITS.propsBytes) } }],
      }))).status
    ).toBe(400);
    expect((await call('POST', '/analytics/events', batch({ platform: 'tv' as never }))).status).toBe(400);
    // Within every other limit, but more than nginx would carry: refused here too.
    const heavy = Array.from({ length: 30 }, (_, i) => ({ ...event(`h${i}`), props: { pad: 'p'.repeat(3000) } }));
    expect((await call('POST', '/analytics/events', batch({ events: heavy }))).status).toBe(413);
    expect(
      (await call('POST', '/analytics/events', batch({ events: [{ ...event('e1'), kind: 'request' as never }] }))).status
    ).toBe(400);
    expect(rows().filter((r) => r.kind !== 'request')).toHaveLength(0);
  });

  it('needs no account, like the pay page', async () => {
    const { status } = await call('POST', '/analytics/events', batch(), { authorization: 'Bearer nope' });
    expect(status).toBe(202);
  });
});

describe('the request log', () => {
  it('keeps nothing unless it is turned on', async () => {
    app = createApp({
      db,
      payments: (repo) =>
        new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
    });
    const { token } = await signUp('Riya');
    await call('GET', '/me', undefined, { authorization: `Bearer ${token}`, [ANALYTICS_HEADERS.device]: 'dev-1' });
    await written();
    expect(rows('request')).toHaveLength(0);
  });

  it('keeps one row per request, with the route as registered and the path as asked', async () => {
    const riya = await signUp('Riya');
    const auth = { authorization: `Bearer ${riya.token}` };
    const group = (await call<{ id: string }>('POST', '/groups', { name: 'Manali', memberNames: ['Kabir'] }, auth)).body;
    await call('GET', `/groups/${group.id}/expenses`, undefined, {
      ...auth,
      [ANALYTICS_HEADERS.device]: 'dev-1',
      [ANALYTICS_HEADERS.session]: 's1',
    });

    await written();
    const log = rows('request');
    // Signing up came from neither an account nor the app (no device header here), so it left none.
    expect(log.map((r) => r.name)).toEqual(['POST /groups', 'GET /groups/:id/expenses']);
    expect(log[0].user_id).toBe(riya.user.id);
    expect(log[0].device_id).toBeNull();

    const read = log[1];
    expect(read.user_id).toBe(riya.user.id);
    expect(read.device_id).toBe('dev-1');
    expect(read.session_id).toBe('s1');
    const props = JSON.parse(read.props!) as { params: Record<string, string>; status: number; ms: number };
    expect(props.params).toEqual({ id: group.id });
    expect(props.status).toBe(200);
    expect(props.ms).toBeGreaterThanOrEqual(0);
    expect(read.id).toMatch(/^r-/);
    expect(JSON.parse(log[0].props!)).not.toHaveProperty('params');
  });

  it('logs a request that failed, with the status it got, under the route it was for', async () => {
    // Turned away before its handler, by auth: the app's, so still a row.
    expect((await call('GET', '/groups/nope', undefined, { [ANALYTICS_HEADERS.device]: 'dev-1' })).status).toBe(401);
    const riya = await signUp('Riya');
    const auth = { authorization: `Bearer ${riya.token}` };
    // No route at all, nor for that method: under one name, with the path beside it.
    expect((await call('GET', '/no-such-route', undefined, auth)).status).toBe(404);
    expect((await call('GET', '/join', undefined, auth)).status).toBe(404);
    // Reached its handler, which threw.
    expect((await call('GET', '/groups/nope', undefined, auth)).status).toBe(404);
    expect((await call('POST', '/groups', { name: '' }, auth)).status).toBe(400);

    await written();
    const log = rows('request');
    expect(log.map((r) => [r.name, JSON.parse(r.props!).status, r.user_id])).toEqual([
      ['GET /groups/:id', 401, null],
      ['GET (no route)', 404, riya.user.id],
      ['GET (no route)', 404, riya.user.id],
      ['GET /groups/:id', 404, riya.user.id],
      ['POST /groups', 400, riya.user.id],
    ]);
    expect(JSON.parse(log[0].props!)).not.toHaveProperty('params');
    expect(JSON.parse(log[0].props!)).not.toHaveProperty('path');
    expect(log.slice(1, 3).map((r) => JSON.parse(r.props!).path)).toEqual(['/no-such-route', '/join']);
    expect(JSON.parse(log[3].props!).params).toEqual({ id: 'nope' });
  });

  it('keeps nothing of a request from neither an account nor the app, like a scanner’s', async () => {
    expect((await call('GET', '/wp-login.php')).status).toBe(401);
    expect((await call('GET', '/groups/nope', undefined, { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await call('POST', '/accounts', { displayName: 'Riya' })).status).toBe(201);
    await written();
    expect(rows('request')).toHaveLength(0);
  });

  it('cuts short a path no route has, so a long one can’t be a name', async () => {
    const long = `/${'x'.repeat(2000)}`;
    expect((await call('GET', long, undefined, { [ANALYTICS_HEADERS.device]: 'dev-1' })).status).toBe(401);
    await written();
    const [row] = rows('request');
    expect(row.name).toBe('GET (no route)');
    expect(JSON.parse(row.props!).path).toBe(long.slice(0, ANALYTICS_LIMITS.text));
  });

  it('never keeps a link’s token', async () => {
    const riya = await signUp('Riya');
    const auth = { authorization: `Bearer ${riya.token}` };
    const group = (await call<{ id: string }>('POST', '/groups', { name: 'Manali', memberNames: ['Kabir'] }, auth)).body;
    const link = (await call<{ token: string }>('POST', `/groups/${group.id}/link`, undefined, auth)).body.token;
    await written();
    db.prepare('DELETE FROM analytics_events').run();

    const fromApp = { [ANALYTICS_HEADERS.device]: 'dev-1' };
    expect((await call('GET', `/g/${link}`, undefined, fromApp)).status).toBe(200);
    expect((await call('GET', `/join/${link}`, undefined, auth)).status).toBe(200);
    expect((await call('GET', `/links/${link}/group`, undefined, auth)).status).toBe(200);
    expect((await call('GET', `/s/${link}/no-such-thing`, undefined, fromApp)).status).toBe(404);

    await written();
    const log = rows('request');
    expect(log.map((r) => r.name)).toEqual(['GET /g/:token', 'GET /join/:token', 'GET /links/:token/group', 'GET (no route)']);
    expect(JSON.parse(log[3].props!).path).toBe('/s/:token/no-such-thing');
    for (const r of log) expect(JSON.stringify(r)).not.toContain(link);
    // Public routes don't need an account, but one sent along is who asked.
    expect(log.map((r) => r.user_id)).toEqual([null, riya.user.id, riya.user.id, null]);
  });

  it('leaves out /health, preflights and the analytics route itself', async () => {
    await call('GET', '/health');
    await app.request('/groups', { method: 'OPTIONS', headers: { origin: 'https://sattle.example', 'access-control-request-method': 'GET' } });
    await call('POST', '/analytics/events', batch());
    await written();
    expect(rows('request')).toHaveLength(0);
  });

  it('drops a request row once it is REQUEST_LOG_DAYS old, and a guest’s events once GUEST_EVENT_DAYS old', async () => {
    const { token } = await signUp('Riya');
    await call('POST', '/analytics/events', batch(), { authorization: `Bearer ${token}` });
    const guest = batch({ deviceId: 'dev-2' }).events.map((e) => ({ ...e, id: `g-${e.id}` }));
    await call('POST', '/analytics/events', batch({ deviceId: 'dev-2', events: guest }));
    await call('GET', '/groups', undefined, { [ANALYTICS_HEADERS.device]: 'dev-3' });
    await written();
    const asked = Date.parse(rows('request')[0].received_at);
    const days = Math.max(REQUEST_LOG_DAYS, GUEST_EVENT_DAYS);
    // The app's GET is a request row (signing up, from neither, isn't); the guest's three are app-reported.
    const going = rows('request').length + guest.length;

    expect(await pruneAnalytics(db, asked + (Math.min(REQUEST_LOG_DAYS, GUEST_EVENT_DAYS) - 1) * DAY)).toBe(0);
    expect(await pruneAnalytics(db, asked + (days + 1) * DAY)).toBe(going);
    expect(rows('request')).toHaveLength(0);
    // What an account reported stays: it's what a statistics page counts.
    expect(rows().map((r) => r.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('drops what an account reported once it is ACCOUNT_EVENT_DAYS old', async () => {
    const { token } = await signUp('Riya');
    await call('POST', '/analytics/events', batch(), { authorization: `Bearer ${token}` });
    const reported = () => rows().filter((r) => r.kind !== 'request').map((r) => r.id);
    const arrived = Date.parse(rows().find((r) => r.id === 'e1')!.received_at);

    await pruneAnalytics(db, arrived + (ACCOUNT_EVENT_DAYS - 1) * DAY);
    expect(reported()).toEqual(['e1', 'e2', 'e3']);
    await pruneAnalytics(db, arrived + (ACCOUNT_EVENT_DAYS + 1) * DAY);
    expect(reported()).toEqual([]);
  });

  it('drops a big backlog in several goes', async () => {
    const old = new Date(Date.now() - (REQUEST_LOG_DAYS + 1) * DAY).toISOString();
    const add = db.prepare(
      `INSERT INTO analytics_events (id, kind, name, device_id, occurred_at, received_at) VALUES (?, 'request', 'GET /groups', 'dev-1', ?, ?)`
    );
    db.exec('BEGIN');
    for (let i = 0; i < 12_000; i++) add.run(`r-${i}`, old, old);
    db.exec('COMMIT');
    expect(await pruneAnalytics(db)).toBe(12_000);
    expect(rows('request')).toHaveLength(0);
  });

  it('keeps what a guest did once that install has made an account', async () => {
    // Before signing up: a guest on dev-1.
    const before = batch().events.map((e) => ({ ...e, id: `g-${e.id}` }));
    await call('POST', '/analytics/events', batch({ events: before }));
    const { token } = await signUp('Riya');
    await call('POST', '/analytics/events', batch(), { authorization: `Bearer ${token}` });
    const arrived = Date.parse(rows().find((r) => r.id === 'g-e1')!.received_at);

    await pruneAnalytics(db, arrived + (GUEST_EVENT_DAYS + 1) * DAY);
    expect(rows().filter((r) => r.kind !== 'request').map((r) => r.id)).toEqual(['g-e1', 'g-e2', 'g-e3', 'e1', 'e2', 'e3']);
  });
});

describe('deleting an account', () => {
  const ids = (prefix: string) => batch().events.map((e) => ({ ...e, id: `${prefix}-${e.id}` }));
  const bearer = (token: string, device = 'dev-1') => ({ authorization: `Bearer ${token}`, [ANALYTICS_HEADERS.device]: device });

  it('deletes its usage record, and what its install did before signing in, and its own deletion names nobody', async () => {
    // A guest on dev-1, who then signs up as Riya there. Kabir is on dev-9.
    await call('POST', '/analytics/events', batch({ events: ids('guest') }));
    const riya = await signUp('Riya');
    const kabir = await signUp('Kabir');
    await call('POST', '/analytics/events', batch({ events: ids('riya') }), bearer(riya.token));
    await call('POST', '/analytics/events', batch({ deviceId: 'dev-9', events: ids('kabir') }), bearer(kabir.token, 'dev-9'));
    await call('GET', '/me', undefined, bearer(riya.token));
    await call('GET', '/me', undefined, bearer(kabir.token, 'dev-9'));

    expect((await call('DELETE', '/me', undefined, bearer(riya.token))).status).toBe(200);
    // Her old token, sent to a public route after: not hers any more.
    await call('GET', '/join/nope', undefined, bearer(riya.token));
    await written();

    expect(rows().filter((r) => r.user_id === riya.user.id)).toEqual([]);
    expect(rows().filter((r) => r.kind !== 'request').map((r) => r.id)).toEqual(['kabir-e1', 'kabir-e2', 'kabir-e3']);
    expect(rows('request').filter((r) => r.user_id === kabir.user.id).map((r) => r.name)).toEqual(['GET /me']);
    const deletion = rows('request').find((r) => r.name === 'DELETE /me')!;
    expect(deletion.user_id).toBeNull();
  });

  it('keeps what an install did before signing in when another account has used it since', async () => {
    await call('POST', '/analytics/events', batch({ events: ids('guest') }));
    const riya = await signUp('Riya');
    const kabir = await signUp('Kabir');
    await call('POST', '/analytics/events', batch({ events: ids('riya') }), bearer(riya.token));
    await call('POST', '/analytics/events', batch({ events: ids('kabir') }), bearer(kabir.token));

    await call('DELETE', '/me', undefined, bearer(riya.token));
    expect(rows().filter((r) => r.kind !== 'request').map((r) => r.id)).toEqual([
      'guest-e1', 'guest-e2', 'guest-e3', 'kabir-e1', 'kabir-e2', 'kabir-e3',
    ]);
  });
});
