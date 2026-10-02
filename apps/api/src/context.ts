import type { User } from '@sattle/core';

import type { Db } from './db';
import type { NwcApi } from './nwc';
import type { PaymentBackend } from './payments';
import type { Repo } from './repo';
import type { WalletStore } from './walletStore';

export type AppEnv = { Variables: { user: User } };

/** What every route module gets. */
export interface Ctx {
  db: Db;
  repo: Repo;
  payments: PaymentBackend;
  wallets: WalletStore;
  /** Opens an NWC connection. A fake in tests. */
  nwc: (uri: string) => NwcApi;
}
