import { beforeEach, describe, expect, it } from 'vitest';

import type { Settlement } from '@sattle/core';

import { createApp } from './app';
import { openDb, seedIfEmpty, type Db } from './db';
import { SimulatedPayments, type PaymentBackend } from './payments';
import type { Repo } from './repo';
import type { EventOptions } from './routes/events';

let db: Db;

/** Doesn't move anything: the settlement stays `created`. */
const stalled: PaymentBackend = { start() {} };
/** Walks created → awaiting_payment → in_flight → confirmed, 40ms apart. */
const simulated = (repo: Repo) =>
  new SimulatedPayments(repo, { stepMs: 40, settleDelayMs: 40, rateFiatPerBtc: 9_000_000, alwaysFail: false });

function app(userId: string, payments: 'sim' | 'stalled' = 'sim', events: EventOptions = {}) {
  return createApp({
    db,
    demoUserId: userId,
    payments: (repo) => (payments === 'sim' ? simulated(repo) : stalled),
    events: { checkMs: 5, ...events },
  });
}

async function omPaysYash(payments: 'sim' | 'stalled' = 'sim') {
  const res = await app('u-om', payments).request('/groups/g-flat/settlements', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fromMemberId: 'm-flat-om', toMemberId: 'm-flat-yash', amount: 120_000, rail: 'invoice' }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Settlement;
}

/** Reads SSE frames until the stream ends or `stop` says so. */
async function read(res: Response, stop: (frames: string[]) => boolean = () => false) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buf = '';
  let ended = false;
  while (!stop(frames)) {
    const { value, done } = await reader.read();
    if (done) {
      ended = true;
      break;
    }
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop()!;
    frames.push(...parts);
  }
  if (!ended) await reader.cancel();
  const statuses = frames
    .filter((f) => f.startsWith('event: settlement'))
    .map((f) => (JSON.parse(f.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as Settlement).status);
  return { frames, statuses, ended };
}

beforeEach(() => {
  db = openDb(':memory:');
  seedIfEmpty(db);
  // The seeded demo link's invoice is already open for Om → Yash.
  db.prepare(`UPDATE settlements SET status = 'expired' WHERE id = 'demo'`).run();
});

describe('GET /settlements/:id/events', () => {
  it('pushes every status, including the awaiting_payment a 2s poll skips, then closes', async () => {
    const s = await omPaysYash();
    const res = await app('u-om').request(`/settlements/${s.id}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const { statuses, ended } = await read(res);
    expect(statuses).toEqual(['created', 'awaiting_payment', 'in_flight', 'confirmed']);
    expect(ended).toBe(true);
  });

  it('sends a finished payment once and closes', async () => {
    const s = await omPaysYash();
    db.prepare(`UPDATE settlements SET status = 'failed' WHERE id = ?`).run(s.id);
    const { statuses, ended } = await read(await app('u-om', 'stalled').request(`/settlements/${s.id}/events`));
    expect(statuses).toEqual(['failed']);
    expect(ended).toBe(true);
  });

  it('keeps a quiet stream alive', async () => {
    const s = await omPaysYash('stalled');
    const res = await app('u-om', 'stalled', { keepAliveMs: 10 }).request(`/settlements/${s.id}/events`);
    const { frames } = await read(res, (f) => f.includes(': keep-alive'));
    expect(frames).toContain(': keep-alive');
  });

  it('gives up after maxMs on a payment that never finishes', async () => {
    const s = await omPaysYash('stalled');
    const { statuses, ended } = await read(await app('u-om', 'stalled', { maxMs: 30 }).request(`/settlements/${s.id}/events`));
    expect(statuses).toEqual(['created']);
    expect(ended).toBe(true);
  });

  it('refuses an unknown payment, and one outside your groups, before opening a stream', async () => {
    const unknown = await app('u-om').request('/settlements/nope/events');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: 'not_found' });

    const s = await omPaysYash('stalled');
    const outsider = await app('u-priya', 'stalled').request(`/settlements/${s.id}/events`);
    expect(outsider.status).toBe(404);
    expect(outsider.headers.get('content-type')).toContain('application/json');
  });

  it('needs sign-in, like the rest of /settlements', async () => {
    const s = await omPaysYash('stalled');
    const res = await createApp({ db, payments: () => stalled }).request(`/settlements/${s.id}/events`);
    expect(res.status).toBe(401);
  });
});
