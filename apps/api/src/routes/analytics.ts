/**
 * How the app is used, kept for a statistics page that doesn't exist yet.
 *
 * The app posts batches of what happened on it (POST /analytics/events):
 * screens opened, taps, hand-offs to other apps, the app going to and from
 * the background, errors shown. The route is public, since a guest on a pay
 * page counts too, but a bearer token sent with it names the account. The
 * server's own rows, one per request it answers, come from requestLog in
 * middleware.ts and land in the same table.
 *
 * Each event carries an id the app made, and a batch sent twice (the answer
 * was lost, the app retried) is kept once. A batch over the limits in
 * ANALYTICS_LIMITS is refused whole, with 400, or 413 for its size, so a bug
 * in the app can't fill the disk. The app keeps under them itself
 * (apps/mobile/src/analytics/tracker.ts). How often one address may post is
 * nginx's to limit (the API's site on the VM, /etc/nginx/sites-available/battle). Neither stops a client that
 * isn't the app posting from many addresses, and the table shares a disk with
 * every settlement, so the server also takes at most ANALYTICS_DAILY_BYTES a
 * day in all, and no one address more than ANALYTICS_ADDRESS_DAILY_BYTES of
 * it, and guest rows go after GUEST_EVENT_DAYS (pruneAnalytics in
 * middleware.ts). Nothing in here is ever read back by a route.
 *
 * Times here are the wall clock's, not nowIso's: nowIso only ever moves
 * forward, a millisecond at a time when called faster than that, so that
 * links and settlements order right. Analytics needs no such order, and
 * calling it once per event would push it ahead of the real time.
 */

import { isIPv6 } from 'node:net';

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import { ANALYTICS_KINDS, ANALYTICS_LIMITS, ANALYTICS_PLATFORMS, type AnalyticsEvent } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { transaction } from '../db';
import { parse } from '../http';

const id = z.string().trim().min(1).max(ANALYTICS_LIMITS.id);
const text = z.string().trim().min(1).max(ANALYTICS_LIMITS.text);
/** Whatever JSON object the app sent, as long as it's small. Never looked into here. */
const props = z
  .record(z.string(), z.unknown())
  .refine((p) => JSON.stringify(p).length <= ANALYTICS_LIMITS.propsBytes, `must be ${ANALYTICS_LIMITS.propsBytes} bytes or fewer as JSON`);
/** ISO 8601, and something Date can read. A device whose clock is nonsense still gets its row, under the server's time. */
const at = z
  .string()
  .max(40)
  .transform((s) => new Date(Number.isFinite(Date.parse(s)) ? s : Date.now()).toISOString());

const EventBody = z.object({
  id,
  sessionId: id,
  seq: z.number().int().nonnegative(),
  kind: z.enum(ANALYTICS_KINDS.filter((k) => k !== 'request') as [AnalyticsEvent['kind'], ...AnalyticsEvent['kind'][]]),
  name: text,
  screen: text.optional(),
  props: props.optional(),
  at,
});

const BatchBody = z.object({
  deviceId: id,
  platform: z.enum(ANALYTICS_PLATFORMS),
  appVersion: text.optional(),
  events: z.array(EventBody).min(1).max(ANALYTICS_LIMITS.eventsPerBatch),
});

/**
 * Bytes of app-reported events the server keeps in a day, over every
 * client. It bounds how fast the table can grow. Counted in memory, so a
 * restart starts the day again.
 */
export const ANALYTICS_DAILY_BYTES = 50 * 1024 * 1024;

/**
 * The most of that one address may use in a day, so a single client can't
 * spend the day's room and leave every real phone turned away until
 * midnight. The address is nginx's X-Real-IP (Cloudflare's visitor address,
 * which the API's nginx site on the VM takes from CF-Connecting-IP); a request
 * without it, as on a dev server, counts as
 * one address, and an IPv6 one counts as its /64 (see sharer). The API takes
 * it as sent, so it trusts it only because in production it listens on
 * 127.0.0.1, behind nginx (server.ts). A whole campus behind one address is
 * still well inside the share: an event is a few hundred bytes.
 */
export const ANALYTICS_ADDRESS_DAILY_BYTES = 5 * 1024 * 1024;

/**
 * Whose share of the day a request comes out of. An IPv6 client has a whole
 * /64 to itself and can take a new address in it whenever it likes, so each
 * address getting its own share would let it spend the day for everyone; the
 * share is the /64's instead. An IPv4 address, IPv4 mapped into IPv6 included,
 * is its own. Anything else, like no address at all, is taken as it is.
 */
export function sharer(address: string): string {
  const ip = address.split('%')[0];
  if (!isIPv6(ip)) return address;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  // An IPv4 tail, as in 64:ff9b::192.0.2.1, is the last two groups.
  const hex = ip.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_, a, b, c, d) =>
    `${((+a << 8) | +b).toString(16)}:${((+c << 8) | +d).toString(16)}`
  );
  const [head, tail] = hex.split('::');
  const groups = (s: string) => (s ? s.split(':') : []);
  const full =
    tail === undefined
      ? groups(head)
      : [...groups(head), ...Array<string>(8 - groups(head).length - groups(tail).length).fill('0'), ...groups(tail)];
  return `${full.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/** Thrown inside the insert to undo a batch past the day's room. */
const FULL = Symbol('analytics: full for today');

export function analyticsRoutes(
  { db, repo }: Ctx,
  { dailyBytes = ANALYTICS_DAILY_BYTES, addressDailyBytes = ANALYTICS_ADDRESS_DAILY_BYTES } = {}
) {
  const r = new Hono<AppEnv>();
  /** What has been kept today (UTC), in all and by address. */
  let taken = { day: '', bytes: 0, byAddress: new Map<string, number>() };
  const insert = db.prepare(
    `INSERT OR IGNORE INTO analytics_events
       (id, user_id, device_id, session_id, seq, kind, name, screen, props, platform, app_version, occurred_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  /**
   * Public. Keeps a batch of events from one device: `{ accepted }`, how many
   * were new. With a bearer token for a live account, the rows are that
   * account's; with none, or one the server no longer knows, they're a guest's.
   *   over the limits, or not shaped like a batch   → 400 invalid_input
   *   over ANALYTICS_LIMITS.batchBytes               → 413 invalid_input
   *   past today's ANALYTICS_DAILY_BYTES, or this
   *   address's ANALYTICS_ADDRESS_DAILY_BYTES          → 429 conflict
   * The app treats a 429 like any failed send: it keeps the batch and tries
   * again later.
   */
  const sized = bodyLimit({
    maxSize: ANALYTICS_LIMITS.batchBytes,
    onError: (c) => c.json({ code: 'invalid_input', message: 'That batch is too big.' }, 413),
  });

  r.post('/analytics/events', sized, async (c) => {
    const body = await c.req.text();
    const batch = parse(BatchBody, JSON.parse(body));
    const now = new Date().toISOString();
    const day = now.slice(0, 10);
    if (taken.day !== day) taken = { day, bytes: 0, byAddress: new Map() };
    const address = sharer(c.req.header('x-real-ip') ?? '');
    const bytes = Buffer.byteLength(body);
    const fromAddress = taken.byAddress.get(address) ?? 0;
    const header = c.req.header('authorization');
    const user = header?.startsWith('Bearer ') ? repo.userByToken(header.slice(7)) : undefined;
    const received = now;
    // Only what is kept counts against the day: a batch sent again after a lost answer, its
    // events already here, stores nothing and costs nothing. So the batch goes in first, and
    // comes out again if what it added would go past the room left.
    let kept = 0;
    let accepted: number;
    try {
      accepted = transaction(db, () => {
        let n = 0;
        for (const e of batch.events) {
          const { changes } = insert.run(
            e.id, user?.id ?? null, batch.deviceId, e.sessionId, e.seq, e.kind, e.name, e.screen ?? null,
            e.props === undefined ? null : JSON.stringify(e.props), batch.platform, batch.appVersion ?? null, e.at, received
          );
          n += Number(changes);
        }
        kept = Math.ceil((bytes * n) / batch.events.length);
        if (taken.bytes + kept > dailyBytes || fromAddress + kept > addressDailyBytes) throw FULL;
        return n;
      });
    } catch (e) {
      if (e !== FULL) throw e;
      return c.json({ code: 'conflict', message: 'That’s enough for today. Try again later.' }, 429);
    }
    taken.bytes += kept;
    taken.byAddress.set(address, fromAddress + kept);
    return c.json({ accepted }, 202);
  });

  return r;
}
