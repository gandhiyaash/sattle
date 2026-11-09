import { Hono } from 'hono';

import { buildHistory } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';

export function historyRoutes({ repo }: Ctx) {
  const r = new Hono<AppEnv>();

  /**
   * Members only. HistoryEntry[], newest first: every expense added, changed
   * or removed, every debt settled, and every change to the group itself,
   * each with when and, where someone did it, who. A settlement is here
   * whole, so a Lightning payment brings its proof with it. Payments that
   * failed or ran out aren't: they moved nothing.
   */
  r.get('/groups/:id/history', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    return c.json(buildHistory(repo.expenses(g.id), repo.expenseChanges(g.id), repo.settlements(g.id), repo.groupLog(g.id)));
  });

  /**
   * Members only. GroupLogEntry[], oldest first: what's changed about the
   * group itself (its settings, its people, its link) and who changed it.
   * Part of GET /sync too, as each group's `log`.
   */
  r.get('/groups/:id/log', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    return c.json(repo.groupLog(g.id));
  });

  return r;
}
