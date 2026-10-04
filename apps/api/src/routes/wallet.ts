/**
 * The payee's NWC connection. This is what lets the server mint invoices
 * into a wallet it can't spend from.
 *
 * The connection string is a secret: walletStore keeps it, no response
 * carries it, and no error message or log line repeats it.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import { NWC_REQUIRED_METHODS, SattleError, parseLightningAddress, type ReceiveAddress } from '@sattle/core';

import type { AppEnv, Ctx } from '../context';
import { transaction } from '../db';
import { parse } from '../http';
import { checkNothingIncoming } from '../groupRules';
import { LnurlError } from '../lnurl';
import { NwcError, parseNwcUri } from '../nwc';
import { nowIso } from '../repo';

export const ConnectWalletBody = z.object({
  nwcUri: z.string().startsWith('nostr+walletconnect://'),
});

export const ReceiveAddressBody = z.object({ address: z.string().max(320) });

export function walletRoutes({ db, repo, wallets, nwc, lnurl }: Ctx) {
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

  /**
   * Forgets the connection string. The user's members go back to `joined`.
   * 409 while a payment to them is under way: this wallet is what confirms
   * it. Returns the WalletConnection, now not connected.
   */
  r.delete('/me/wallet', (c) => {
    const user = c.get('user');
    const gone = transaction(db, () => {
      checkNothingIncoming(repo, user.id);
      return wallets.remove(user.id);
    });
    return c.json(gone);
  });

  /** ReceiveAddress: the user's own Lightning address for receiving, or null. */
  r.get('/me/receive-address', (c) => {
    const body: ReceiveAddress = { address: wallets.receiveAddress(c.get('user').id) ?? null };
    return c.json(body);
  });

  /**
   * Sets the user's own Lightning address for receiving, used in every group
   * when they have no NWC connection. Before saving, the address is asked
   * for its payment details, so a typo or a dead address is caught now and
   * not when someone tries to pay.
   *   not an address              → 400 invalid_address
   *   doesn't answer              → 503 network
   *   answers, but not usefully   → 400 invalid_address
   */
  r.put('/me/receive-address', async (c) => {
    const user = c.get('user');
    const { address } = parse(ReceiveAddressBody, await c.req.json(), 'invalid_address');
    const parsed = parseLightningAddress(address);
    if (!parsed.ok) throw new SattleError('invalid_address', parsed.reason);

    if (lnurl) {
      try {
        await lnurl.payParams(parsed.address);
      } catch (e) {
        throw receiveAddressError(e);
      }
    }
    wallets.setReceiveAddress(user.id, parsed.address);
    const body: ReceiveAddress = { address: parsed.address };
    return c.json(body);
  });

  r.delete('/me/receive-address', (c) => {
    wallets.setReceiveAddress(c.get('user').id, null);
    const body: ReceiveAddress = { address: null };
    return c.json(body);
  });

  return r;
}

function receiveAddressError(e: unknown) {
  if (e instanceof LnurlError) {
    switch (e.code) {
      case 'UNREACHABLE':
        return new SattleError('network', 'That address didn’t answer. Check it’s right, or try again in a minute.');
      case 'PROVIDER_ERROR':
        return new SattleError('invalid_address', `That address’s wallet said: ${e.message}`);
      default:
        return new SattleError('invalid_address', 'That address can’t receive payments. Check it’s right.');
    }
  }
  console.error('receive address: check failed unexpectedly', e instanceof Error ? e.message : e);
  return new SattleError('internal', 'Something went wrong on our side.');
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
