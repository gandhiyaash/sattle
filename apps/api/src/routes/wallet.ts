/**
 * The payee's NWC connection. This is what lets the server mint invoices
 * into a wallet it can't spend from.
 *
 * The connection string is a secret: walletStore keeps it, no response
 * carries it, and no error message or log line repeats it.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import { NWC_REQUIRED_METHODS, SattleError } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { transaction } from '../db';
import { parse } from '../http';
import { NwcError, parseNwcUri } from '../nwc';
import { nowIso } from '../repo';

export const ConnectWalletBody = z.object({
  nwcUri: z.string().startsWith('nostr+walletconnect://'),
});

export function walletRoutes({ db, wallets, nwc }: Ctx) {
  const r = new Hono<AppEnv>();

  /**
   * Parses the URI and calls get_info. Refuses (400 invalid_wallet) unless
   * the connection grants make_invoice and lookup_invoice; anything beyond
   * what the server needs comes back in excessMethods so the UI can warn.
   * On success the user's members become `nwc_linked`. Returns WalletConnection.
   */
  r.put('/me/wallet', async (c) => {
    const user = c.get('user');
    const { nwcUri } = parse(ConnectWalletBody, await c.req.json(), 'invalid_wallet');
    const conn = parseNwcUri(nwcUri);

    const client = nwc(nwcUri);
    let info;
    try {
      info = await client.getInfo();
    } catch (e) {
      throw walletError(e);
    } finally {
      client.close();
    }

    const missing = NWC_REQUIRED_METHODS.filter((m) => !info.methods.includes(m));
    if (missing.length > 0) {
      throw new SattleError(
        'invalid_wallet',
        `This connection can’t ${missing.join(' or ').replaceAll('_', ' ')}. Make a new one that allows receiving.`
      );
    }

    const saved = transaction(db, () =>
      wallets.save(user.id, {
        nwcUri,
        walletPubkey: conn.walletPubkey,
        methods: info.methods,
        alias: info.alias,
        connectedAt: nowIso(),
      })
    );
    return c.json(saved);
  });

  /** WalletConnection; `{ connected: false, methods: [], excessMethods: [] }` when none. */
  r.get('/me/wallet', (c) => c.json(wallets.connection(c.get('user').id)));

  return r;
}

/** What went wrong reaching the wallet, in words that don't repeat the string. */
function walletError(e: unknown) {
  if (e instanceof SattleError) return e;
  if (e instanceof NwcError) {
    if (e.code === 'TIMEOUT' || e.code === 'RELAY') {
      return new SattleError('network', 'Your wallet didn’t answer. Check it’s online, then try again.');
    }
    return new SattleError('invalid_wallet', `Your wallet refused the connection (${e.code}).`);
  }
  console.error('wallet: get_info failed unexpectedly', e instanceof Error ? e.name : typeof e);
  return new SattleError('internal', 'Something went wrong on our side.');
}
