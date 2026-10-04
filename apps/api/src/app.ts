/**
 * App assembly. The contract is apps/mobile/src/client/ApiClient.ts — one
 * method there, one route in routes/, same shapes.
 *
 * Route modules are split by owner so two people can work in parallel:
 *   routes/accounts.ts     device accounts: a name in, a token out
 *   routes/groups.ts       groups, members, expenses, debts
 *   routes/settlements.ts  direct and manual settlement
 *   routes/payLinks.ts     /groups/:id/pay-links and the public /s/:token
 *   routes/invites.ts      /groups/:id/invites, the public /join/:token, and joining
 *   routes/wallet.ts       the payee's NWC connection
 *   routes/events.ts       server-sent events for payment status
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { SattleError } from '@sattle/core';

import type { AppEnv, Ctx } from './context';
import type { Db } from './db';
import { STATUS } from './http';
import { auth } from './middleware';
import { NwcClient, type NwcApi } from './nwc';
import type { PaymentBackend } from './payments';
import { createRepo, type Repo } from './repo';
import { accountRoutes } from './routes/accounts';
import { eventRoutes, type EventOptions } from './routes/events';
import { groupRoutes } from './routes/groups';
import { inviteRoutes } from './routes/invites';
import { payLinkRoutes } from './routes/payLinks';
import { settlementRoutes } from './routes/settlements';
import { walletRoutes } from './routes/wallet';
import { createWalletStore, type WalletStore } from './walletStore';

export interface AppDeps {
  db: Db;
  payments: (repo: Repo, wallets: WalletStore) => PaymentBackend;
  /** Defaults to a real NwcClient over the URI's relays. */
  nwc?: (uri: string) => NwcApi;
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
  const ctx: Ctx = { db: deps.db, repo, wallets, nwc, payments: deps.payments(repo, wallets) };
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

  app.get('/health', (c) => c.json({ ok: true }));
  app.route('/', accountRoutes(ctx));
  app.route('/', groupRoutes(ctx));
  app.route('/', settlementRoutes(ctx));
  app.route('/', payLinkRoutes(ctx));
  app.route('/', inviteRoutes(ctx));
  app.route('/', walletRoutes(ctx));
  app.route('/', eventRoutes(ctx, deps.events));

  return app;
}
