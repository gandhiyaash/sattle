import { Hono } from 'hono';

import type { AppEnv, Ctx } from '../context';

export function ledgerRoutes({ repo, ledger }: Ctx) {
  const r = new Hono<AppEnv>();

  /** Members only: the backup URI carries the key that decrypts the group. */
  r.get('/groups/:id/ledger', (c) => {
    const g = repo.groupForUser(c.req.param('id'), c.get('user').id);
    return c.json(ledger.backup(g.id));
  });

  return r;
}
