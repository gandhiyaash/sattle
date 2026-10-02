/**
 * Server-sent events, so a screen sees every status a payment passes
 * through instead of whatever a 2s poll happens to land on.
 *
 * Each stream re-reads its row every `checkMs` and pushes it when it has
 * changed. That catches every writer (the simulator, NWC, manual settle-ups)
 * without hooking into repo.ts or the payment backends, and a primary-key
 * read on SQLite costs next to nothing.
 *
 * Every stream sends the current state on connect, a keep-alive comment so
 * proxies don't cut it, and closes once the payment is finished or after
 * `maxMs`. Clients fall back to polling whenever a stream isn't available.
 *
 * EventSource can't send an Authorization header. Under DEMO_USER_ID that
 * doesn't matter; with real tokens this needs a short-lived stream ticket
 * before it's useful on authed routes. The guest stream (/s/:token/events,
 * after O3) is public and doesn't have the problem.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { SattleError, TERMINAL_STATUSES, type Settlement } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';

export interface EventOptions {
  checkMs?: number;
  keepAliveMs?: number;
  /** A stream never outlives this, so a row stuck open can't hold a connection forever. */
  maxMs?: number;
}

export function eventRoutes({ repo }: Ctx, opts: EventOptions = {}) {
  const checkMs = opts.checkMs ?? 250;
  const keepAliveMs = opts.keepAliveMs ?? 15_000;
  const maxMs = opts.maxMs ?? 10 * 60_000;
  const r = new Hono<AppEnv>();

  /** Authed, same check as GET /settlements/:id. Event `settlement`, data: the Settlement. */
  r.get('/settlements/:id/events', (c) => {
    const id = c.req.param('id');
    const first = repo.settlement(id);
    if (!first) throw new SattleError('not_found', 'That payment doesn’t exist.');
    repo.groupForUser(first.groupId, c.get('user').id);

    return streamSSE(c, async (stream) => {
      const started = Date.now();
      let sent = '';
      let quietSince = Date.now();

      while (!stream.aborted && Date.now() - started < maxMs) {
        const s = repo.settlement(id);
        if (!s) break;
        const json = JSON.stringify(s);
        if (json !== sent) {
          sent = json;
          quietSince = Date.now();
          await stream.writeSSE({ event: 'settlement', data: json });
          if (isFinished(s)) break;
        } else if (Date.now() - quietSince >= keepAliveMs) {
          quietSince = Date.now();
          await stream.write(': keep-alive\n\n');
        }
        await stream.sleep(checkMs);
      }
    });
  });

  return r;
}

const isFinished = (s: Settlement) => TERMINAL_STATUSES.includes(s.status);
