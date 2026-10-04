/**
 * Getting an invoice from a Lightning address, the way any wallet does
 * (LUD-16 → LUD-06), and asking whether it was paid (LUD-21).
 *
 *   1. GET https://<domain>/.well-known/lnurlp/<name>: the pay parameters.
 *      Cached per address for a few minutes; they rarely change.
 *   2. GET <callback>?amount=<msat>: an invoice.
 *   3. Optionally, GET <verify>: whether that invoice was paid, with the
 *      preimage once it was.
 *
 * Everything an LNURL server says is checked before we act on it. The
 * invoice must be for exactly the amount we asked, commit to the metadata
 * we were given, be on our network and not already expired. A verify answer
 * only counts as paid when its preimage hashes to the invoice's payment
 * hash: "settled: true" on its own is the provider's word, the preimage is
 * proof.
 *
 * Every request goes through safeFetch: the domain is whatever a user typed.
 */

import { createHash } from 'node:crypto';

import { parseLightningAddress } from '@sattle/core';

import { Bolt11Error, decodeBolt11 } from './bolt11';
import { preimageMatches } from './nwc';
import { getJson, SafeFetchError, type JsonResponse, type SafeFetchOptions } from './safeFetch';

export type LnurlErrorCode =
  | 'INVALID_ADDRESS'
  /** Couldn't connect, timed out, or the address points somewhere private. */
  | 'UNREACHABLE'
  /** The server answered, but not with something we can use. */
  | 'BAD_RESPONSE'
  /** The server refused, with its own reason. */
  | 'PROVIDER_ERROR'
  | 'AMOUNT_OUT_OF_RANGE'
  /** The invoice doesn't match what we asked for. */
  | 'BAD_INVOICE';

export class LnurlError extends Error {
  override name = 'LnurlError';
  constructor(
    readonly code: LnurlErrorCode,
    message: string,
    /** For AMOUNT_OUT_OF_RANGE. */
    readonly range?: { minMsat: number; maxMsat: number }
  ) {
    super(message);
  }
}

export interface PayParams {
  callback: string;
  minSendableMsat: number;
  maxSendableMsat: number;
  /** The raw JSON string: the invoice's description hash is over these exact bytes. */
  metadata: string;
}

export interface AddressInvoice {
  invoice: string;
  paymentHash: string;
  amountMsat: number;
  /** Unix seconds, from the invoice itself. */
  expiresAt: number;
  /** LUD-21. Absent when the provider can't tell us; then only a proof confirms it. */
  verifyUrl?: string;
}

export type VerifyResult = { settled: false } | { settled: true; preimage: string };

export interface LnurlClientOptions {
  /** The invoice's network must match. `bc` is mainnet. */
  network?: string;
  /** How long pay parameters are reused. */
  cacheMs?: number;
  /** Caps the cache so typing many addresses can't grow memory without bound. */
  cacheEntries?: number;
  fetch?: SafeFetchOptions;
  now?: () => number;
  /** Tests: stand-in for the network. */
  getJson?: (url: string, opts?: SafeFetchOptions) => Promise<JsonResponse>;
}

/** A provider's own error text is shown to people, so it's kept short and plain. */
const MAX_REASON = 120;

export class LnurlClient {
  private readonly network: string;
  private readonly cacheMs: number;
  private readonly cacheEntries: number;
  private readonly now: () => number;
  private readonly fetchJson: (url: string) => Promise<JsonResponse>;
  private readonly cache = new Map<string, { params: PayParams; until: number }>();

  constructor(opts: LnurlClientOptions = {}) {
    this.network = opts.network ?? 'bc';
    this.cacheMs = opts.cacheMs ?? 5 * 60_000;
    this.cacheEntries = opts.cacheEntries ?? 1_000;
    this.now = opts.now ?? Date.now;
    const get = opts.getJson ?? getJson;
    this.fetchJson = (url) => get(url, opts.fetch);
  }

  /** Step 1. Throws LnurlError. */
  async payParams(address: string): Promise<PayParams> {
    const parsed = parseLightningAddress(address);
    if (!parsed.ok) throw new LnurlError('INVALID_ADDRESS', parsed.reason);
    const key = parsed.address;

    const hit = this.cache.get(key);
    if (hit && hit.until > this.now()) return hit.params;
    this.cache.delete(key);

    const [name, domain] = key.split('@');
    const body = await this.request(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`);
    const params = readPayParams(body);

    if (this.cache.size >= this.cacheEntries) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { params, until: this.now() + this.cacheMs });
    return params;
  }

  /** Steps 1 and 2: an invoice for exactly `amountMsat`, checked. Throws LnurlError. */
  async requestInvoice(address: string, amountMsat: number): Promise<AddressInvoice> {
    const params = await this.payParams(address);
    if (amountMsat < params.minSendableMsat || amountMsat > params.maxSendableMsat) {
      throw new LnurlError('AMOUNT_OUT_OF_RANGE', 'That amount is outside what this address accepts.', {
        minMsat: params.minSendableMsat,
        maxMsat: params.maxSendableMsat,
      });
    }

    // The callback may carry its own query; ours is added to it (LUD-06).
    const url = new URL(params.callback);
    url.searchParams.set('amount', String(amountMsat));
    const body = await this.request(url.toString());

    const pr = field(body, 'pr');
    if (typeof pr !== 'string') throw new LnurlError('BAD_RESPONSE', 'The address didn’t send an invoice.');

    let inv;
    try {
      inv = decodeBolt11(pr);
    } catch (e) {
      throw new LnurlError('BAD_INVOICE', e instanceof Bolt11Error ? e.message : 'The invoice couldn’t be read.');
    }
    if (inv.network !== this.network) throw new LnurlError('BAD_INVOICE', 'The invoice is for a different Lightning network.');
    if (inv.amountMsat !== amountMsat) throw new LnurlError('BAD_INVOICE', 'The invoice is for a different amount than we asked for.');
    if (inv.descriptionHash !== sha256Hex(params.metadata)) {
      throw new LnurlError('BAD_INVOICE', 'The invoice doesn’t match the address’s details.');
    }
    if (inv.expiresAt * 1000 <= this.now()) throw new LnurlError('BAD_INVOICE', 'The invoice had already expired.');

    const verify = field(body, 'verify');
    return {
      invoice: pr,
      paymentHash: inv.paymentHash,
      amountMsat,
      expiresAt: inv.expiresAt,
      verifyUrl: typeof verify === 'string' && isHttpsUrl(verify) ? verify : undefined,
    };
  }

  /**
   * Step 3. Paid only with a preimage for this invoice's hash. Throws
   * LnurlError when the provider can't be asked; that is "don't know", not
   * "unpaid", and the caller asks again later.
   */
  async verify(verifyUrl: string, paymentHash: string): Promise<VerifyResult> {
    const body = await this.request(verifyUrl);
    if (field(body, 'settled') !== true) return { settled: false };
    const preimage = field(body, 'preimage');
    if (typeof preimage === 'string' && preimageMatches(preimage.toLowerCase(), paymentHash)) {
      return { settled: true, preimage: preimage.toLowerCase() };
    }
    // Settled, but no proof we can check: keep asking rather than trust it.
    return { settled: false };
  }

  /** GET, mapping transport failures and LNURL error answers to LnurlError. */
  private async request(url: string): Promise<unknown> {
    let res: JsonResponse;
    try {
      res = await this.fetchJson(url);
    } catch (e) {
      if (e instanceof SafeFetchError) {
        if (e.code === 'BAD_JSON' || e.code === 'TOO_LARGE' || e.code === 'REDIRECT') {
          throw new LnurlError('BAD_RESPONSE', 'The address’s server sent something we can’t use.');
        }
        throw new LnurlError('UNREACHABLE', 'The address’s server couldn’t be reached.');
      }
      throw e;
    }

    // LNURL errors usually come as 200 with status ERROR; some send a 4xx too.
    if (field(res.body, 'status') === 'ERROR') {
      throw new LnurlError('PROVIDER_ERROR', plainReason(field(res.body, 'reason')));
    }
    if (res.status === 404) throw new LnurlError('PROVIDER_ERROR', 'The address doesn’t exist.');
    if (res.status < 200 || res.status >= 300) throw new LnurlError('BAD_RESPONSE', `The address’s server answered ${res.status}.`);
    return res.body;
  }
}

function readPayParams(body: unknown): PayParams {
  const bad = (what: string) => new LnurlError('BAD_RESPONSE', `The address’s server sent ${what}.`);
  if (field(body, 'tag') !== 'payRequest') throw bad('something other than payment details');

  const callback = field(body, 'callback');
  if (typeof callback !== 'string' || !isHttpsUrl(callback)) throw bad('an unusable payment link');

  const min = field(body, 'minSendable');
  const max = field(body, 'maxSendable');
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || (min as number) < 1 || (min as number) > (max as number)) {
    throw bad('amount limits that don’t make sense');
  }

  const metadata = field(body, 'metadata');
  if (typeof metadata !== 'string') throw bad('no description');
  try {
    if (!Array.isArray(JSON.parse(metadata))) throw new Error();
  } catch {
    throw bad('a description we can’t read');
  }

  return { callback, minSendableMsat: min as number, maxSendableMsat: max as number, metadata };
}

function field(body: unknown, key: string): unknown {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>)[key] : undefined;
}

function isHttpsUrl(s: string) {
  try {
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
}

function plainReason(reason: unknown) {
  if (typeof reason !== 'string') return 'The address refused the request.';
  // Strip control characters and markup-ish noise; it's someone else's text.
  const clean = reason.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'The address refused the request.';
  return clean.length > MAX_REASON ? `${clean.slice(0, MAX_REASON - 1)}…` : clean;
}

function sha256Hex(s: string) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
