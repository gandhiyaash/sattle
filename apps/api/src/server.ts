import { serve } from '@hono/node-server';

import { createApp } from './app';
import { openDb, seedIfEmpty } from './db';
import { NwcClient } from './nwc';
import { SimulatedPayments } from './payments';
import { NwcPayments } from './payments/nwc';
import { createRateService } from './rates';

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
};

const env = process.env;
const port = num(env.PORT, 3000);
const db = openDb(env.DATABASE_PATH ?? 'data/sattle.db');
if (env.SEED !== 'false') seedIfEmpty(db);

// PAYMENTS=nwc mints real invoices on payees' wallets; anything else simulates.
const realPayments = env.PAYMENTS === 'nwc';

// A `created` row never got an invoice to anyone, so nothing can have moved.
// The simulator's timers also live in memory, so under it `in_flight` rows
// will never finish either. Real invoices (awaiting_payment) are left for the
// confirmation loop to pick up again.
const interrupted = realPayments ? `('created')` : `('created', 'in_flight')`;
db.prepare(
  `UPDATE settlements SET status = 'failed', failure_reason = 'Interrupted by a server restart. Nothing moved.',
     updated_at = ? WHERE status IN ${interrupted}`
).run(new Date().toISOString());

let nwcPayments: NwcPayments | undefined;
const rates = createRateService({ fallback: { INR: num(env.RATE_FALLBACK_INR_PER_BTC, 9_000_000) } });

const app = createApp({
  db,
  demoUserId: env.DEMO_USER_ID || undefined,
  corsOrigin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(',') : '*',
  payments: (repo, wallets) =>
    realPayments
      ? (nwcPayments = new NwcPayments({ db, repo, wallets, rates, nwc: (uri) => new NwcClient(uri) }))
      : new SimulatedPayments(repo, {
          stepMs: num(env.SIM_STEP_MS, 400),
          settleDelayMs: num(env.SIM_SETTLE_MS, 2500),
          rateFiatPerBtc: num(env.SIM_RATE_FIAT_PER_BTC, 9_000_000),
          alwaysFail: env.SIM_ALWAYS_FAIL === 'true',
        }),
});

const resumed = nwcPayments?.resume() ?? 0;

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`sattle api on http://localhost:${info.port} (${realPayments ? 'real NWC payments' : 'simulated payments'})`);
  if (resumed > 0) console.log(`  watching ${resumed} open invoice(s) from before the restart`);
  if (env.DEMO_USER_ID) console.log(`  unauthenticated requests act as ${env.DEMO_USER_ID} (dev only)`);
});
