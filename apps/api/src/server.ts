import { serve } from '@hono/node-server';

import { createApp } from './app';
import { openDb, seedIfEmpty } from './db';
import { SimulatedPayments } from './payments';

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
};

const env = process.env;
const port = num(env.PORT, 3000);
const db = openDb(env.DATABASE_PATH ?? 'data/sattle.db');
if (env.SEED !== 'false') seedIfEmpty(db);

// The simulator's timers live in memory. Anything it was driving when the
// process died will never finish, so close it out honestly on boot.
db.prepare(
  `UPDATE settlements SET status = 'failed', failure_reason = 'Interrupted by a server restart. Nothing moved.',
     updated_at = ? WHERE status IN ('created', 'in_flight')`
).run(new Date().toISOString());

const app = createApp({
  db,
  demoUserId: env.DEMO_USER_ID || undefined,
  corsOrigin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(',') : '*',
  payments: (repo) =>
    new SimulatedPayments(repo, {
      stepMs: num(env.SIM_STEP_MS, 400),
      settleDelayMs: num(env.SIM_SETTLE_MS, 2500),
      rateFiatPerBtc: num(env.SIM_RATE_FIAT_PER_BTC, 9_000_000),
      alwaysFail: env.SIM_ALWAYS_FAIL === 'true',
    }),
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`sattle api on http://localhost:${info.port}`);
  if (env.DEMO_USER_ID) console.log(`  unauthenticated requests act as ${env.DEMO_USER_ID} (dev only)`);
});
