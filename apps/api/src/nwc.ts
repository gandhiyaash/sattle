/**
 * Nostr Wallet Connect (NIP-47), just the three calls the server needs:
 * get_info, make_invoice and lookup_invoice. All three are receive-side, so
 * a connection that grants only these can mint invoices but never spend.
 *
 * A request is a kind 23194 event to the wallet, encrypted to its pubkey and
 * signed with the connection's secret; the wallet answers with a kind 23195
 * that tags the request id. Wallets that advertise `nip44_v2` in their info
 * event (kind 13194) get NIP-44; everyone else gets NIP-04.
 *
 * The connection string is a secret. Nothing here logs it, puts it in an
 * error message, or lets it show up when the client is printed.
 */

import { createHash } from 'node:crypto';
import { inspect } from 'node:util';

import type { Event, Filter } from 'nostr-tools';
import * as nip04 from 'nostr-tools/nip04';
import * as nip44 from 'nostr-tools/nip44';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';

import { SattleError } from '@sattle/core';

const INFO_KIND = 13194;
const REQUEST_KIND = 23194;
const RESPONSE_KIND = 23195;

// ---------------------------------------------------------------------------
// The connection string
// ---------------------------------------------------------------------------

export interface NwcConnection {
  walletPubkey: string;
  relays: string[];
  /** Hex. The client's signing key for this connection. */
  secret: string;
  lud16?: string;
}

const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * `nostr+walletconnect://<wallet pubkey>?relay=wss://…&secret=<hex>[&lud16=…]`.
 * Some wallets leave out the `//`, and some list several relays.
 */
export function parseNwcUri(uri: string): NwcConnection {
  const bad = (why: string) => new SattleError('invalid_wallet', `That isn’t a wallet connection string: ${why}.`);

  const m = /^nostr\+walletconnect:(?:\/\/)?([^?]*)\?(.*)$/i.exec(uri.trim());
  if (!m) throw bad('it should start with nostr+walletconnect://');
  const walletPubkey = m[1].toLowerCase();
  if (!HEX64.test(walletPubkey)) throw bad('the wallet key is missing or malformed');

  const params = new URLSearchParams(m[2]);
  const relays = params.getAll('relay').filter((r) => /^wss?:\/\/./i.test(r));
  if (relays.length === 0) throw bad('it names no relay');
  const secret = params.get('secret') ?? '';
  if (!HEX64.test(secret)) throw bad('the secret is missing or malformed');

  return { walletPubkey, relays, secret: secret.toLowerCase(), lud16: params.get('lud16') ?? undefined };
}

// ---------------------------------------------------------------------------
// Transport: how events reach the relays. Swapped for an in-memory one in tests.
// ---------------------------------------------------------------------------

export interface NostrTransport {
  /** Resolves once at least one relay has accepted the event. */
  publish(event: Event): Promise<void>;
  subscribe(filter: Filter, onEvent: (event: Event) => void): () => void;
  /** One stored event matching the filter, or null after `maxWaitMs`. */
  get(filter: Filter, maxWaitMs: number): Promise<Event | null>;
  close(): void;
}

export function relayTransport(relays: string[]): NostrTransport {
  const pool = new SimplePool();
  return {
    async publish(event) {
      try {
        await Promise.any(pool.publish(relays, event));
      } catch {
        throw new NwcError('RELAY', 'Couldn’t reach the wallet’s relay.');
      }
    },
    subscribe(filter, onEvent) {
      const sub = pool.subscribeMany(relays, filter, { onevent: onEvent });
      return () => sub.close();
    },
    get: (filter, maxWaitMs) => pool.get(relays, filter, { maxWait: maxWaitMs }),
    close: () => pool.close(relays),
  };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** A NIP-47 error from the wallet (RATE_LIMITED, UNAUTHORIZED, …), or our own TIMEOUT/RELAY/BAD_RESPONSE. */
export class NwcError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'NwcError';
  }
}

export interface NwcInfo {
  alias?: string;
  network?: string;
  /** The wallet node's pubkey, not the connection's. */
  pubkey?: string;
  /** What this connection is allowed to do. */
  methods: string[];
}

export type InvoiceState = 'pending' | 'settled' | 'expired' | 'failed';

export interface NwcInvoice {
  invoice: string;
  paymentHash: string;
  amountMsat: number;
  /** Unix seconds. */
  createdAt: number;
  expiresAt?: number;
  settledAt?: number;
  /** Hex. Only once settled. Check it with preimageMatches before showing it as proof. */
  preimage?: string;
  state: InvoiceState;
}

export interface MakeInvoiceParams {
  amountMsat: number;
  description?: string;
  /** Seconds. Keep it no longer than the quote, or a lapsed invoice can still be paid. */
  expirySec?: number;
}

/**
 * The preimage hashes to the invoice's payment hash. Use it to check a
 * settled answer is consistent before showing the preimage as a receipt;
 * whether it was paid comes from `state`.
 */
export function preimageMatches(preimage: string, paymentHash: string) {
  if (!HEX64.test(preimage) || !HEX64.test(paymentHash)) return false;
  return createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex') === paymentHash.toLowerCase();
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface NwcClientOptions {
  transport?: NostrTransport;
  /** Per request. */
  timeoutMs?: number;
  now?: () => number;
}

type Encryption = 'nip44_v2' | 'nip04';

/** What the rest of the server uses, so tests can hand in a fake wallet. */
export type NwcApi = Pick<NwcClient, 'getInfo' | 'makeInvoice' | 'lookupInvoice' | 'close'>;

export class NwcClient {
  readonly walletPubkey: string;
  readonly relays: string[];
  readonly #secret: Uint8Array;
  readonly #clientPubkey: string;
  readonly #transport: NostrTransport;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  #encryption?: Promise<Encryption>;

  constructor(uri: string, opts: NwcClientOptions = {}) {
    const conn = parseNwcUri(uri);
    this.walletPubkey = conn.walletPubkey;
    this.relays = conn.relays;
    this.#secret = hexToBytes(conn.secret);
    this.#clientPubkey = getPublicKey(this.#secret);
    this.#transport = opts.transport ?? relayTransport(conn.relays);
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
    this.#now = opts.now ?? Date.now;
  }

  async getInfo(): Promise<NwcInfo> {
    const r = await this.#request<Record<string, unknown>>('get_info', {});
    return {
      alias: str(r.alias),
      network: str(r.network),
      pubkey: str(r.pubkey),
      methods: Array.isArray(r.methods) ? r.methods.filter((m): m is string => typeof m === 'string') : [],
    };
  }

  async makeInvoice(p: MakeInvoiceParams): Promise<NwcInvoice> {
    if (!Number.isInteger(p.amountMsat) || p.amountMsat < 1000) {
      throw new NwcError('INVALID_AMOUNT', 'An invoice needs at least 1 sat, in whole millisats.');
    }
    const r = await this.#request<Record<string, unknown>>('make_invoice', {
      amount: p.amountMsat,
      ...(p.description !== undefined && { description: p.description }),
      ...(p.expirySec !== undefined && { expiry: p.expirySec }),
    });
    return this.#toInvoice(r);
  }

  async lookupInvoice(by: { paymentHash: string } | { invoice: string }): Promise<NwcInvoice> {
    const params = 'paymentHash' in by ? { payment_hash: by.paymentHash } : { invoice: by.invoice };
    return this.#toInvoice(await this.#request<Record<string, unknown>>('lookup_invoice', params));
  }

  close() {
    this.#transport.close();
  }

  /** Printing the client shows where it points, never the secret. */
  [inspect.custom]() {
    return `NwcClient(${this.walletPubkey.slice(0, 8)}… via ${this.relays.join(', ')})`;
  }
  toJSON() {
    return { walletPubkey: this.walletPubkey, relays: this.relays };
  }

  // -------------------------------------------------------------------------

  #encryptionFor(): Promise<Encryption> {
    this.#encryption ??= this.#transport
      .get({ kinds: [INFO_KIND], authors: [this.walletPubkey], limit: 1 }, 3_000)
      .then((info) => {
        const offered = info?.tags.find((t) => t[0] === 'encryption')?.[1]?.split(' ') ?? [];
        // No tag at all means a wallet from before NIP-44 was added to NIP-47.
        return offered.includes('nip44_v2') ? 'nip44_v2' : 'nip04';
      })
      .catch(() => 'nip04' as const);
    return this.#encryption;
  }

  #encrypt(plaintext: string, scheme: Encryption) {
    return scheme === 'nip44_v2'
      ? nip44.encrypt(plaintext, nip44.getConversationKey(this.#secret, this.walletPubkey))
      : nip04.encrypt(this.#secret, this.walletPubkey, plaintext);
  }

  #decrypt(payload: string) {
    // NIP-04 payloads carry their IV after `?iv=`; NIP-44 payloads are bare base64.
    return payload.includes('?iv=')
      ? nip04.decrypt(this.#secret, this.walletPubkey, payload)
      : nip44.decrypt(payload, nip44.getConversationKey(this.#secret, this.walletPubkey));
  }

  async #request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const scheme = await this.#encryptionFor();
    const nowSec = Math.floor(this.#now() / 1000);
    const request = finalizeEvent(
      {
        kind: REQUEST_KIND,
        created_at: nowSec,
        tags: [
          ['p', this.walletPubkey],
          ...(scheme === 'nip44_v2' ? [['encryption', 'nip44_v2']] : []),
          // A wallet that only sees this after we've given up shouldn't act on it.
          ['expiration', String(nowSec + Math.ceil(this.#timeoutMs / 1000))],
        ],
        content: this.#encrypt(JSON.stringify({ method, params }), scheme),
      },
      this.#secret
    );

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        fn();
      };

      const timer = setTimeout(
        () => finish(() => reject(new NwcError('TIMEOUT', `The wallet didn’t answer ${method} in time.`))),
        this.#timeoutMs
      );

      const unsubscribe = this.#transport.subscribe(
        { kinds: [RESPONSE_KIND], authors: [this.walletPubkey], '#e': [request.id] },
        (event) => {
          if (event.pubkey !== this.walletPubkey) return;
          if (!event.tags.some((t) => t[0] === 'e' && t[1] === request.id)) return;
          finish(() => {
            try {
              resolve(this.#readResponse<T>(method, event));
            } catch (e) {
              reject(e);
            }
          });
        }
      );

      this.#transport.publish(request).catch((e) => finish(() => reject(e)));
    });
  }

  #readResponse<T>(method: string, event: Event): T {
    let body: { result_type?: string; error?: { code?: string; message?: string } | null; result?: unknown };
    try {
      body = JSON.parse(this.#decrypt(event.content));
    } catch {
      throw new NwcError('BAD_RESPONSE', `The wallet’s answer to ${method} couldn’t be read.`);
    }
    if (body.error) {
      throw new NwcError(body.error.code ?? 'INTERNAL', body.error.message ?? `The wallet refused ${method}.`);
    }
    if (body.result_type !== method || !body.result || typeof body.result !== 'object') {
      throw new NwcError('BAD_RESPONSE', `The wallet answered ${method} with something else.`);
    }
    return body.result as T;
  }

  #toInvoice(r: Record<string, unknown>): NwcInvoice {
    const invoice = str(r.invoice);
    const paymentHash = str(r.payment_hash);
    if (!invoice || !paymentHash) throw new NwcError('BAD_RESPONSE', 'The wallet sent an invoice without its hash.');

    const expiresAt = num(r.expires_at);
    const settledAt = num(r.settled_at);
    const state = invoiceState(str(r.state), { settledAt, expiresAt }, this.#now());
    return {
      invoice,
      paymentHash: paymentHash.toLowerCase(),
      amountMsat: num(r.amount) ?? 0,
      createdAt: num(r.created_at) ?? Math.floor(this.#now() / 1000),
      expiresAt,
      settledAt,
      // Only passed on once paid, so nobody mistakes it for proof earlier.
      preimage: state === 'settled' ? str(r.preimage) || undefined : undefined,
      state,
    };
  }
}

/**
 * Newer wallets send `state`; older ones only `settled_at`.
 * Expiry is inferred from `expires_at` when the wallet doesn't say.
 */
function invoiceState(
  stated: string | undefined,
  { settledAt, expiresAt }: { settledAt?: number; expiresAt?: number },
  nowMs: number
): InvoiceState {
  if (stated === 'settled' || stated === 'pending' || stated === 'expired' || stated === 'failed') {
    // A wallet that says pending past the expiry is just slow to notice.
    if (stated === 'pending' && expiresAt !== undefined && expiresAt * 1000 < nowMs) return 'expired';
    return stated;
  }
  // Not the preimage: for an incoming invoice the wallet made it, and some
  // wallets return it before anyone has paid.
  if (settledAt) return 'settled';
  if (expiresAt !== undefined && expiresAt * 1000 < nowMs) return 'expired';
  return 'pending';
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
