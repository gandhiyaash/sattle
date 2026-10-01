import type { User } from '@sattle/core';

import type { Db } from './db';
import type { PaymentBackend } from './payments';
import type { Repo } from './repo';

export type AppEnv = { Variables: { user: User } };

/** What every route module gets. */
export interface Ctx {
  db: Db;
  repo: Repo;
  payments: PaymentBackend;
}
