/**
 * App assembly. The contract is apps/mobile/src/client/ApiClient.ts — one
 * method there, one route in routes/, same shapes.
 *
 * Route modules are split by owner so two people can work in parallel:
 *   routes/accounts.ts     device accounts: a name in, a token out
 *   routes/groups.ts       groups, members, expenses, debts
 *   routes/settlements.ts  direct and manual settlement
 *   routes/payLinks.ts     /groups/:id/pay-links and the public /s/:token
 *   routes/joining.ts      joining with the group link: the public /join/:token, /links/:token/group, join requests
 *   routes/groupLinks.ts   /groups/:id/link and the public /g/:token
 *   routes/wallet.ts       the payee's NWC connection
 *   routes/events.ts       server-sent events for payment status
 *   routes/ledger.ts       the group's backup key for its ledger on Nostr
 *   routes/history.ts      what has happened in a group: expenses added, changed and removed, and debts settled
 *   routes/upi.ts          a UPI ID on the account, and paying a debt over UPI
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { SattleError } from '@sattle/core';

import type { AppEnv, Ctx } from './context';
import type { Db } from './db';
import { STATUS } from './http';
import { auth } from './middleware';
import { NostrLedger } from './nostrLedger';
import { NwcClient, type NwcApi } from './nwc';
import type { PaymentBackend } from './payments';
import { createRepo, type Repo } from './repo';
import { accountRoutes } from './routes/accounts';
import type { LnurlClient } from './lnurl';
import { eventRoutes, type EventOptions } from './routes/events';
import { groupRoutes } from './routes/groups';
import { groupLinkRoutes } from './routes/groupLinks';
import { historyRoutes } from './routes/history';
import { joinRoutes } from './routes/joining';
import { ledgerRoutes } from './routes/ledger';
import { payLinkRoutes } from './routes/payLinks';
import { settlementRoutes } from './routes/settlements';
import { upiRoutes } from './routes/upi';
import { walletRoutes } from './routes/wallet';
import { createWalletStore, type WalletStore } from './walletStore';

export interface AppDeps {
  db: Db;
  payments: (repo: Repo, wallets: WalletStore) => PaymentBackend;
  /** Checks a receive address answers before it's saved; without it, any well-formed address is kept. */
  lnurl?: Pick<LnurlClient, 'payParams'>;
  /** Defaults to a real NwcClient over the URI's relays. */
  nwc?: (uri: string) => NwcApi;
  /** Mirrors the ledger to Nostr. Defaults to one that signs entries but publishes nowhere. */
  ledger?: NostrLedger;
  /** Stream timings; tests shorten them. */
  events?: EventOptions;
  /** Acts as this user when no bearer token is sent. Dev only — unset in production. */
  demoUserId?: string;
  corsOrigin?: string | string[];
}

export function createApp(deps: AppDeps) {
  const repo = createRepo(deps.db);
  const wallets = createWalletStore(deps.db);
  const nwc = deps.nwc ?? ((uri: string) => new NwcClient(uri));
  const ledger = deps.ledger ?? new NostrLedger({ db: deps.db, relays: [] });
  const ctx: Ctx = { db: deps.db, repo, wallets, nwc, ledger, lnurl: deps.lnurl, payments: deps.payments(repo, wallets) };
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof SattleError) {
      return c.json({ code: err.code, message: err.message }, STATUS[err.code] ?? 400);
    }
    if (err instanceof SyntaxError) {
      return c.json({ code: 'invalid_input', message: 'Request body isn’t valid JSON.' }, 400);
    }
    console.error(err);
    return c.json({ code: 'internal', message: 'Something went wrong on our side.' }, 500);
  });

  app.notFound((c) => c.json({ code: 'not_found', message: 'No such route.' }, 404));

  app.use(
    '*',
    cors({
      origin: deps.corsOrigin ?? '*',
      allowHeaders: ['authorization', 'content-type', 'idempotency-key'],
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    })
  );
  app.use('*', auth(repo, deps.demoUserId));

  // Public, so the app knows who it can offer to pay before anyone signs in.
  app.get('/health', (c) => c.json({ ok: true, payments: ctx.payments.mode ?? 'simulated' }));
  app.route('/', accountRoutes(ctx));
  app.route('/', groupRoutes(ctx));
  app.route('/', settlementRoutes(ctx));
  app.route('/', payLinkRoutes(ctx));
  app.route('/', joinRoutes(ctx));
  app.route('/', groupLinkRoutes(ctx));
  app.route('/', walletRoutes(ctx));
  app.route('/', eventRoutes(ctx, deps.events));
  app.route('/', ledgerRoutes(ctx));
  app.route('/', historyRoutes(ctx));
  app.route('/', upiRoutes(ctx));

  return app;
}
