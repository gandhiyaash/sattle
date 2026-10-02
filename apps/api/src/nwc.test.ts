import { createHash, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

import type { Event, Filter } from 'nostr-tools';
import { matchFilter } from 'nostr-tools';
import * as nip04 from 'nostr-tools/nip04';
import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { describe, expect, it } from 'vitest';

import { NwcClient, NwcError, parseNwcUri, preimageMatches, type NostrTransport } from './nwc';

/** One in-memory relay. Stored events are what `get` can find. */
function memoryRelay() {
  const subs = new Set<{ filter: Filter; on: (e: Event) => void }>();
  const stored: Event[] = [];
  const transport: NostrTransport = {
    async publish(e) {
      stored.push(e);
      for (const s of [...subs]) if (matchFilter(s.filter, e)) s.on(e);
    },
    subscribe(filter, on) {
      const s = { filter, on };
      subs.add(s);
      return () => subs.delete(s);
    },
    async get(filter) {
      return stored.find((e) => matchFilter(filter, e)) ?? null;
    },
    close() {},
  };
  return { transport, subs };
}

type Handler = (method: string, params: Record<string, unknown>) => unknown;

/** A wallet on the relay that answers requests the way a NIP-47 wallet would. */
function fakeWallet(
  relay: ReturnType<typeof memoryRelay>,
  { encryption, handle, silent = false }: { encryption: 'nip44_v2' | 'nip04' | 'none'; handle: Handler; silent?: boolean }
) {
  const walletSk = generateSecretKey();
  const walletPk = getPublicKey(walletSk);
  const clientSk = generateSecretKey();
  const seen: Event[] = [];

  if (encryption !== 'none') {
    void relay.transport.publish(
      finalizeEvent(
        { kind: 13194, created_at: 0, tags: [['encryption', encryption === 'nip44_v2' ? 'nip44_v2 nip04' : 'nip04']], content: 'get_info make_invoice lookup_invoice' },
        walletSk
      )
    );
  }

  relay.transport.subscribe({ kinds: [23194], '#p': [walletPk] }, (req) => {
    seen.push(req);
    if (silent) return;
    const usesNip44 = req.tags.some((t) => t[0] === 'encryption' && t[1] === 'nip44_v2');
    const key = nip44.getConversationKey(walletSk, req.pubkey);
    const plain = usesNip44 ? nip44.decrypt(req.content, key) : nip04.decrypt(walletSk, req.pubkey, req.content);
    const { method, params } = JSON.parse(plain);
    let body: unknown;
    try {
      body = { result_type: method, result: handle(method, params) };
    } catch (e) {
      body = { result_type: method, error: { code: (e as NwcError).code, message: (e as Error).message } };
    }
    const json = JSON.stringify(body);
    void relay.transport.publish(
      finalizeEvent(
        {
          kind: 23195,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['e', req.id], ['p', req.pubkey]],
          content: usesNip44 ? nip44.encrypt(json, key) : nip04.encrypt(walletSk, req.pubkey, json),
        },
        walletSk
      )
    );
  });

  const uri = `nostr+walletconnect://${walletPk}?relay=wss%3A%2F%2Frelay.example&secret=${bytesToHex(clientSk)}`;
  return { uri, seen, clientSk };
}

const preimage = randomBytes(32).toString('hex');
const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
const now = Math.floor(Date.now() / 1000);

const wallet: Handler = (method, params) => {
  switch (method) {
    case 'get_info':
      return { alias: 'Test Hub', network: 'mainnet', methods: ['get_info', 'make_invoice', 'lookup_invoice', 'pay_invoice'] };
    case 'make_invoice':
      return { type: 'incoming', invoice: 'lnbc10n1test', payment_hash: paymentHash, amount: params.amount, created_at: now, expires_at: now + Number(params.expiry ?? 3600) };
    case 'lookup_invoice':
      if (params.payment_hash !== paymentHash) throw new NwcError('NOT_FOUND', 'No such invoice');
      return { type: 'incoming', invoice: 'lnbc10n1test', payment_hash: paymentHash, amount: 1000, created_at: now, expires_at: now + 90, settled_at: now + 5, preimage };
  }
  throw new NwcError('NOT_IMPLEMENTED', method);
};

describe('parseNwcUri', () => {
  const pk = 'a'.repeat(64);
  const secret = 'b'.repeat(64);

  it('reads the wallet key, every relay and the secret', () => {
    const c = parseNwcUri(`nostr+walletconnect://${pk}?relay=wss://one&relay=wss%3A%2F%2Ftwo&secret=${secret}&lud16=me@x.com`);
    expect(c).toEqual({ walletPubkey: pk, relays: ['wss://one', 'wss://two'], secret, lud16: 'me@x.com' });
  });

  it('accepts the form without //', () => {
    expect(parseNwcUri(`nostr+walletconnect:${pk}?relay=wss://one&secret=${secret}`).walletPubkey).toBe(pk);
  });

  it.each([
    ['another scheme', `nostr+other://${pk}?relay=wss://r&secret=${secret}`],
    ['a short key', `nostr+walletconnect://abc?relay=wss://r&secret=${secret}`],
    ['no relay', `nostr+walletconnect://${pk}?secret=${secret}`],
    ['an http relay', `nostr+walletconnect://${pk}?relay=https://r&secret=${secret}`],
    ['no secret', `nostr+walletconnect://${pk}?relay=wss://r`],
  ])('refuses %s, without echoing the string', (_, uri) => {
    try {
      parseNwcUri(uri);
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: 'invalid_wallet' });
      expect((e as Error).message).not.toContain(secret);
    }
  });
});

describe('NwcClient', () => {
  it.each(['nip44_v2', 'nip04', 'none'] as const)('talks to a wallet that offers %s', async (encryption) => {
    const relay = memoryRelay();
    const w = fakeWallet(relay, { encryption, handle: wallet });
    const client = new NwcClient(w.uri, { transport: relay.transport });

    expect(await client.getInfo()).toEqual({
      alias: 'Test Hub',
      network: 'mainnet',
      pubkey: undefined,
      methods: ['get_info', 'make_invoice', 'lookup_invoice', 'pay_invoice'],
    });
    const sentNip44 = w.seen[0].tags.some((t) => t[0] === 'encryption' && t[1] === 'nip44_v2');
    expect(sentNip44).toBe(encryption === 'nip44_v2');
  });

  it('mints an invoice and reads it back as settled', async () => {
    const relay = memoryRelay();
    const client = new NwcClient(fakeWallet(relay, { encryption: 'nip44_v2', handle: wallet }).uri, { transport: relay.transport });

    const inv = await client.makeInvoice({ amountMsat: 1000, description: 'Flat 4B', expirySec: 90 });
    expect(inv).toMatchObject({ invoice: 'lnbc10n1test', paymentHash, amountMsat: 1000, state: 'pending', expiresAt: now + 90 });
    expect(inv.preimage).toBeUndefined();

    const back = await client.lookupInvoice({ paymentHash: inv.paymentHash });
    expect(back).toMatchObject({ state: 'settled', settledAt: now + 5, preimage });
    expect(preimageMatches(back.preimage!, back.paymentHash)).toBe(true);
  });

  it('signs requests with the connection key and tags the wallet', async () => {
    const relay = memoryRelay();
    const w = fakeWallet(relay, { encryption: 'nip44_v2', handle: wallet });
    await new NwcClient(w.uri, { transport: relay.transport }).getInfo();
    const req = w.seen[0];
    expect(req.kind).toBe(23194);
    expect(req.pubkey).toBe(getPublicKey(w.clientSk));
    expect(req.tags.find((t) => t[0] === 'expiration')).toBeDefined();
  });

  it('turns a wallet error into an NwcError with its code', async () => {
    const relay = memoryRelay();
    const client = new NwcClient(fakeWallet(relay, { encryption: 'nip04', handle: wallet }).uri, { transport: relay.transport });
    await expect(client.lookupInvoice({ paymentHash: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('gives up when the wallet never answers', async () => {
    const relay = memoryRelay();
    const w = fakeWallet(relay, { encryption: 'nip04', handle: wallet, silent: true });
    const client = new NwcClient(w.uri, { transport: relay.transport, timeoutMs: 20 });
    await expect(client.getInfo()).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(relay.subs.size).toBe(1); // only the wallet's own subscription is left
  });

  it('ignores a response signed by someone else', async () => {
    const relay = memoryRelay();
    const w = fakeWallet(relay, { encryption: 'nip04', handle: wallet, silent: true });
    const client = new NwcClient(w.uri, { transport: relay.transport, timeoutMs: 50 });
    const pending = client.getInfo();
    await new Promise((r) => setTimeout(r, 5));
    const impostor = generateSecretKey();
    await relay.transport.publish(
      finalizeEvent({ kind: 23195, created_at: now, tags: [['e', w.seen[0].id]], content: 'x' }, impostor)
    );
    await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('refuses an amount under 1 sat before asking the wallet', async () => {
    const relay = memoryRelay();
    const w = fakeWallet(relay, { encryption: 'nip04', handle: wallet });
    await expect(new NwcClient(w.uri, { transport: relay.transport }).makeInvoice({ amountMsat: 999 })).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    });
    expect(w.seen).toHaveLength(0);
  });

  it('never prints the secret', () => {
    const relay = memoryRelay();
    const w = fakeWallet(relay, { encryption: 'nip04', handle: wallet });
    const client = new NwcClient(w.uri, { transport: relay.transport });
    const secret = bytesToHex(w.clientSk);
    expect(inspect(client)).not.toContain(secret);
    expect(JSON.stringify(client)).not.toContain(secret);
  });
});

describe('invoice state', () => {
  const lookup = (fields: Record<string, unknown>) => {
    const relay = memoryRelay();
    const w = fakeWallet(relay, {
      encryption: 'nip04',
      handle: () => ({ invoice: 'lnbc1', payment_hash: paymentHash, amount: 1000, created_at: now, ...fields }),
    });
    return new NwcClient(w.uri, { transport: relay.transport }).lookupInvoice({ paymentHash });
  };

  it('does not treat a preimage alone as paid', async () => {
    const inv = await lookup({ preimage, expires_at: now + 60 });
    expect(inv.state).toBe('pending');
    expect(inv.preimage).toBeUndefined();
  });

  it('infers expiry when the wallet does not say', async () => {
    expect((await lookup({ expires_at: now - 1 })).state).toBe('expired');
  });

  it('trusts an explicit state, except pending past the expiry', async () => {
    expect((await lookup({ state: 'settled', settled_at: now, preimage })).state).toBe('settled');
    expect((await lookup({ state: 'pending', expires_at: now - 1 })).state).toBe('expired');
  });
});
