import { serve } from '@hono/node-server';
import { npubEncode } from 'nostr-tools/nip19';

import { createApp } from './app';
import { openDb, seedIfEmpty } from './db';
import { productionProblems, productionWarnings } from './env';
import { NostrLedger } from './nostrLedger';
import { LnurlClient } from './lnurl';
import { NwcClient } from './nwc';
import { SimulatedPayments } from './payments';
import { LightningPayments } from './payments/lightning';
import { createRateService } from './rates';

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
};

const env = process.env;
// Before the database is even opened, so a demo setting can't seed it first.
const problems = productionProblems(env);
if (problems.length > 0) {
  console.error(
    ['Refusing to start in production with demo settings:', ...problems.map((p) => `  - ${p}`),
     'Remove them from apps/api/.env and restart.'].join('\n')
  );
  process.exit(1);
}
for (const warning of productionWarnings(env)) console.warn(`WARNING: ${warning}`);
const port = num(env.PORT, 3000);
const db = openDb(env.DATABASE_PATH ?? 'data/sattle.db');
// Demo fixtures are opt-in, so a production database starts empty.
if (env.SEED === 'true') seedIfEmpty(db);

// PAYMENTS=nwc gets real invoices from payees' wallets (NWC) or their own
// Lightning addresses; anything else simulates.
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

let lightning: LightningPayments | undefined;
// One client for checking receive addresses and minting from them, so the
// pay details fetched on save are reused. `bc` is mainnet; LIGHTNING_NETWORK=tbs for signet.
const lnurl = realPayments ? new LnurlClient({ network: env.LIGHTNING_NETWORK || 'bc' }) : undefined;
// No fixed rate unless one is set: when every source is down and none has answered yet, a payment fails rather than guess.
const rates = createRateService(
  env.RATE_FALLBACK_INR_PER_BTC ? { fallback: { INR: num(env.RATE_FALLBACK_INR_PER_BTC, 0) } } : {}
);

// Unset or empty: entries are signed and kept, and go out once relays are set.
const ledgerRelays = (env.LEDGER_RELAYS ?? '').split(',').map((r) => r.trim()).filter(Boolean);
const ledger = new NostrLedger({ db, relays: ledgerRelays });

const app = createApp({
  db,
  ledger,
  demoUserId: env.DEMO_USER_ID || undefined,
  lnurl,
  corsOrigin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(',') : '*',
  payments: (repo, wallets) =>
    realPayments
      ? (lightning = new LightningPayments({
          db,
          repo,
          wallets,
          rates,
          nwc: (uri) => new NwcClient(uri),
          lnurl,
        }))
      : new SimulatedPayments(repo, {
          stepMs: num(env.SIM_STEP_MS, 400),
          settleDelayMs: num(env.SIM_SETTLE_MS, 2500),
          rateFiatPerBtc: num(env.SIM_RATE_FIAT_PER_BTC, 9_000_000),
          alwaysFail: env.SIM_ALWAYS_FAIL === 'true',
        }),
});

const resumed = lightning?.resume() ?? 0;
ledger.start();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`sattle api on http://localhost:${info.port} (${realPayments ? 'real payments' : 'simulated payments'})`);
  if (resumed > 0) console.log(`  watching ${resumed} open invoice(s) from before the restart`);
  console.log(
    ledgerRelays.length > 0
      ? `  ledger mirrored to ${ledgerRelays.length} relay(s) as ${npubEncode(ledger.pubkey)}`
      : '  ledger signed but not published (LEDGER_RELAYS is unset)'
  );
  if (env.DEMO_USER_ID) console.log(`  unauthenticated requests act as ${env.DEMO_USER_ID} (dev only)`);
});
