import type { User } from '@sattle/core';

import type { Db } from './db';
import type { NostrLedger } from './nostrLedger';
import type { LnurlClient } from './lnurl';
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
  /** The group ledger mirrored to Nostr. */
  ledger: NostrLedger;
  /** Opens an NWC connection. A fake in tests. */
  nwc: (uri: string) => NwcApi;
  /** Checks a receive address answers before it's saved. Absent when payments are simulated. */
  lnurl?: Pick<LnurlClient, 'payParams'>;
}
