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
 * nginx's to limit (apps/api/deploy/nginx.conf). Nothing in here is ever read
 * back by a route.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import { ANALYTICS_KINDS, ANALYTICS_LIMITS, ANALYTICS_PLATFORMS, type AnalyticsEvent } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { transaction } from '../db';
import { parse } from '../http';
import { nowIso } from '../repo';

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
  .transform((s) => (Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : nowIso()));

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

export function analyticsRoutes({ db, repo }: Ctx) {
  const r = new Hono<AppEnv>();
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
   */
  const sized = bodyLimit({
    maxSize: ANALYTICS_LIMITS.batchBytes,
    onError: (c) => c.json({ code: 'invalid_input', message: 'That batch is too big.' }, 413),
  });

  r.post('/analytics/events', sized, async (c) => {
    const batch = parse(BatchBody, await c.req.json());
    const header = c.req.header('authorization');
    const user = header?.startsWith('Bearer ') ? repo.userByToken(header.slice(7)) : undefined;
    const received = nowIso();
    const accepted = transaction(db, () => {
      let n = 0;
      for (const e of batch.events) {
        const { changes } = insert.run(
          e.id, user?.id ?? null, batch.deviceId, e.sessionId, e.seq, e.kind, e.name, e.screen ?? null,
          e.props === undefined ? null : JSON.stringify(e.props), batch.platform, batch.appVersion ?? null, e.at, received
        );
        n += Number(changes);
      }
      return n;
    });
    return c.json({ accepted }, 202);
  });

  return r;
}
