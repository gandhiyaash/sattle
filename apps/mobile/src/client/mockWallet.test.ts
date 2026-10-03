import { describe, expect, it } from 'vitest';

import { MockClient } from './MockClient';

const client = () => new MockClient({ latencyMs: 0 });

describe('MockClient.connectWallet', () => {
  it('grants just what the server needs by default', async () => {
    const conn = await client().connectWallet('nostr+walletconnect://abc?relay=wss://r');
    expect(conn).toMatchObject({ connected: true, excessMethods: [] });
    expect(conn.methods).toEqual(expect.arrayContaining(['make_invoice', 'lookup_invoice']));
  });

  it('reports methods beyond that as excess', async () => {
    const conn = await client().connectWallet(
      'nostr+walletconnect://abc?relay=wss://r&mock_methods=get_info,make_invoice,lookup_invoice,pay_invoice'
    );
    expect(conn.excessMethods).toEqual(['pay_invoice']);
  });

  it('refuses a connection that can’t receive', async () => {
    await expect(
      client().connectWallet('nostr+walletconnect://abc?mock_methods=get_info,make_invoice')
    ).rejects.toMatchObject({ code: 'invalid_wallet' });
  });

  it('marks the user’s members as nwc_linked', async () => {
    const c = client();
    await c.connectWallet('nostr+walletconnect://abc');
    const me = (await c.getMembers('g-goa')).find((m) => m.claimedByUserId === 'u-yash');
    expect(me?.status).toBe('nwc_linked');
  });
});
