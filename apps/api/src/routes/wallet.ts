/**
 * The payee's NWC connection. This is what lets the server mint invoices
 * into a wallet it can't spend from.
 *
 * Needs migration 003: a wallet_connections table keyed by user_id. The
 * connection string is a secret — store it, never return it, never log it.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv, Ctx } from '../context';
import { notImplemented, parse } from '../http';

export const ConnectWalletBody = z.object({
  nwcUri: z.string().startsWith('nostr+walletconnect://'),
});

export function walletRoutes(_ctx: Ctx) {
  const r = new Hono<AppEnv>();

  /**
   * Parse the URI, call get_info, and refuse (400 invalid_wallet) unless it
   * grants make_invoice and lookup_invoice (NWC_REQUIRED_METHODS). Anything
   * beyond that goes in excessMethods so the UI can warn. On success, set the
   * user's members to `nwc_linked`. Returns WalletConnection.
   */
  r.put('/me/wallet', async (c) => {
    parse(ConnectWalletBody, await c.req.json(), 'invalid_wallet');
    return notImplemented('Connecting a wallet');
  });

  /** WalletConnection; `{ connected: false, methods: [], excessMethods: [] }` when none. */
  r.get('/me/wallet', () => notImplemented('Connecting a wallet'));

  return r;
}
