/**
 * How a user receives: their NWC connection, their own Lightning address,
 * and their UPI ID. Kept apart from repo.ts as the only module that reads nwc_uri.
 * Everything it returns to a route is a WalletConnection, which has no
 * field for the string.
 */

import { NWC_REQUIRED_METHODS, type WalletConnection } from '@sattle/core';

import type { Db } from './db';

/** get_info isn't excess: it's how the server checks the connection works. */
const NEEDED = new Set<string>([...NWC_REQUIRED_METHODS, 'get_info']);

export const excessMethods = (methods: string[]) => methods.filter((m) => !NEEDED.has(m));

interface Row {
  user_id: string;
  nwc_uri: string;
  wallet_pubkey: string;
  methods: string;
  alias: string | null;
  connected_at: string;
}

export function createWalletStore(db: Db) {
  const q = {
    byUser: db.prepare('SELECT * FROM wallet_connections WHERE user_id = ?'),
    upsert: db.prepare(
      `INSERT INTO wallet_connections (user_id, nwc_uri, wallet_pubkey, methods, alias, connected_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET nwc_uri = excluded.nwc_uri, wallet_pubkey = excluded.wallet_pubkey,
         methods = excluded.methods, alias = excluded.alias, connected_at = excluded.connected_at`
    ),
    linkMembers: db.prepare(`UPDATE members SET status = 'nwc_linked' WHERE claimed_by_user_id = ?`),
    receiveAddress: db.prepare('SELECT receive_address FROM users WHERE id = ?'),
    setReceiveAddress: db.prepare('UPDATE users SET receive_address = ? WHERE id = ?'),
    upiId: db.prepare('SELECT upi_id FROM users WHERE id = ?'),
    setUpiId: db.prepare('UPDATE users SET upi_id = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM wallet_connections WHERE user_id = ?'),
    unlinkMembers: db.prepare(`UPDATE members SET status = 'joined' WHERE claimed_by_user_id = ? AND status = 'nwc_linked'`),
  };

  const toConnection = (r: Row): WalletConnection => {
    const methods = JSON.parse(r.methods) as string[];
    return {
      connected: true,
      methods,
      excessMethods: excessMethods(methods),
      alias: r.alias ?? undefined,
      connectedAt: r.connected_at,
    };
  };

  return {
    connection(userId: string): WalletConnection {
      const r = q.byUser.get(userId) as unknown as Row | undefined;
      return r ? toConnection(r) : { connected: false, methods: [], excessMethods: [] };
    },

    /** Replaces any earlier connection, and marks every member the user has claimed as nwc_linked. */
    save(
      userId: string,
      c: { nwcUri: string; walletPubkey: string; methods: string[]; alias?: string; connectedAt: string }
    ): WalletConnection {
      q.upsert.run(userId, c.nwcUri, c.walletPubkey, JSON.stringify(c.methods), c.alias ?? null, c.connectedAt);
      q.linkMembers.run(userId);
      return toConnection(q.byUser.get(userId) as unknown as Row);
    },

    /** Forgets the connection string, and puts the user's members back to `joined`. */
    remove(userId: string): WalletConnection {
      q.remove.run(userId);
      q.unlinkMembers.run(userId);
      return { connected: false, methods: [], excessMethods: [] };
    },

    /** The user's own Lightning address for receiving, if they've set one. Not a secret. */
    receiveAddress(userId: string): string | undefined {
      return (q.receiveAddress.get(userId) as { receive_address: string | null } | undefined)?.receive_address ?? undefined;
    },

    setReceiveAddress(userId: string, address: string | null) {
      q.setReceiveAddress.run(address, userId);
    },

    /** The user's own UPI ID, if they've set one. Shown only to someone who owes them. */
    upiId(userId: string): string | undefined {
      return (q.upiId.get(userId) as { upi_id: string | null } | undefined)?.upi_id ?? undefined;
    },

    setUpiId(userId: string, upiId: string | null) {
      q.setUpiId.run(upiId, userId);
    },

    /** The secret, for the payment backend only. Never put it in a response. */
    nwcUriFor(userId: string): string | undefined {
      return (q.byUser.get(userId) as unknown as Row | undefined)?.nwc_uri;
    },
  };
}

export type WalletStore = ReturnType<typeof createWalletStore>;
