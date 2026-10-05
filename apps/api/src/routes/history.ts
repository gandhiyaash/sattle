import { Hono } from 'hono';

import { buildHistory } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';

export function historyRoutes({ repo }: Ctx) {
  const r = new Hono<AppEnv>();

  /**
   * Members only. HistoryEntry[], newest first: every expense added, changed
   * or removed, and every debt settled, each with when and, where someone did
   * it, who. A settlement is here whole, so a Lightning payment brings its
   * proof with it. Payments that failed or ran out aren't: they moved nothing.
   */
  r.get('/groups/:id/history', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    return c.json(buildHistory(repo.expenses(g.id), repo.expenseChanges(g.id), repo.settlements(g.id)));
  });

  return r;
}
