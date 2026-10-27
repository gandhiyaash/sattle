/**
 * POST /analytics/events, and the request log beside it: what the app
 * reports of itself and what the server sees it do, both in analytics_events.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { ANALYTICS_HEADERS, ANALYTICS_LIMITS, type AnalyticsBatch, type User } from '@sattle/core';

import { createApp } from './app';
import { openDb, type Db } from './db';
import { REQUEST_LOG_DAYS, pruneRequestLog } from './middleware';
import { SimulatedPayments } from './payments';

let db: Db;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({
    db,
    payments: (repo) =>
      new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
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
    expect(log.map((r) => r.name)).toEqual(['POST /accounts', 'POST /groups', 'GET /groups/:id/expenses']);
    expect(log[0].user_id).toBeNull();
    expect(log[1].user_id).toBe(riya.user.id);
    expect(log[1].device_id).toBeNull();

    const read = log[2];
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
    // Turned away before its handler, by auth.
    expect((await call('GET', '/groups/nope')).status).toBe(401);
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
      ['POST /accounts', 201, null],
      ['GET (no route)', 404, riya.user.id],
      ['GET (no route)', 404, riya.user.id],
      ['GET /groups/:id', 404, riya.user.id],
      ['POST /groups', 400, riya.user.id],
    ]);
    expect(JSON.parse(log[0].props!)).not.toHaveProperty('params');
    expect(JSON.parse(log[0].props!)).not.toHaveProperty('path');
    expect(log.slice(2, 4).map((r) => JSON.parse(r.props!).path)).toEqual(['/no-such-route', '/join']);
    expect(JSON.parse(log[4].props!).params).toEqual({ id: 'nope' });
  });

  it('cuts short a path no route has, so a scanner’s can’t be long', async () => {
    const long = `/${'x'.repeat(2000)}`;
    // No token, as a scanner sends none: turned away by auth, and still logged.
    expect((await call('GET', long)).status).toBe(401);
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

    expect((await call('GET', `/g/${link}`)).status).toBe(200);
    expect((await call('GET', `/join/${link}`, undefined, auth)).status).toBe(200);
    expect((await call('GET', `/links/${link}/group`, undefined, auth)).status).toBe(200);
    expect((await call('GET', `/s/${link}/no-such-thing`)).status).toBe(404);

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

  it('drops a request row once it is REQUEST_LOG_DAYS old, and nothing the app reported', async () => {
    await call('POST', '/analytics/events', batch());
    await call('GET', '/groups');
    await written();
    const asked = Date.parse(rows('request')[0].occurred_at);

    expect(pruneRequestLog(db, asked + (REQUEST_LOG_DAYS - 1) * DAY)).toBe(0);
    expect(pruneRequestLog(db, asked + (REQUEST_LOG_DAYS + 1) * DAY)).toBe(1);
    expect(rows('request')).toHaveLength(0);
    expect(rows().map((r) => r.id)).toEqual(['e1', 'e2', 'e3']);
  });
});
