/**
 * Reads the parts of a BOLT11 invoice we act on: its payment hash, amount,
 * description hash and expiry. Invoices from an LNURL server come from a
 * stranger, so the server checks these before anyone is shown one.
 *
 * The signature isn't checked. The payer's wallet checks it before paying,
 * and what we need is that the invoice is for the amount we asked for and
 * that a preimage for its hash proves payment. A forged signature changes
 * neither: no wallet would pay it.
 *
 * Spec: https://github.com/lightning/bolts/blob/master/11-payment-encoding.md
 */

import { bech32 } from '@scure/base';

export interface Bolt11 {
  /** `bc` mainnet, `tb` testnet, `tbs` signet, `bcrt` regtest. */
  network: string;
  /** Absent for an invoice that lets the payer choose. */
  amountMsat?: number;
  /** Hex, 32 bytes. */
  paymentHash: string;
  /** Hex, 32 bytes. LNURL-pay invoices commit to the metadata with this. */
  descriptionHash?: string;
  description?: string;
  /** Unix seconds. */
  createdAt: number;
  /** Unix seconds. */
  expiresAt: number;
}

export class Bolt11Error extends Error {
  override name = 'Bolt11Error';
}

const NETWORKS = ['bcrt', 'bc', 'tbs', 'tb'];
/** msat in one BTC, divided by each multiplier. */
const MSAT_PER = { '': 100_000_000_000n, m: 100_000_000n, u: 100_000n, n: 100n, p: 0n } as const;
const DEFAULT_EXPIRY_SEC = 3600;
/** 65 bytes of signature and recovery id, in 5-bit words. */
const SIGNATURE_WORDS = 104;
const TAG = { paymentHash: 1, description: 13, descriptionHash: 23, expiry: 6 } as const;

export function decodeBolt11(raw: string): Bolt11 {
  const invoice = raw.trim().toLowerCase().replace(/^lightning:/, '');
  let decoded;
  try {
    decoded = bech32.decode(invoice as `${string}1${string}`, false);
  } catch {
    throw new Bolt11Error('Not a Lightning invoice.');
  }

  const { network, amountMsat } = readPrefix(decoded.prefix);
  const words = decoded.words;
  if (words.length < 7 + SIGNATURE_WORDS) throw new Bolt11Error('Invoice is too short.');

  const createdAt = toInt(words.slice(0, 7));
  const fields = words.slice(7, words.length - SIGNATURE_WORDS);

  let paymentHash: string | undefined;
  let descriptionHash: string | undefined;
  let description: string | undefined;
  let expirySec = DEFAULT_EXPIRY_SEC;

  for (let i = 0; i < fields.length; ) {
    if (i + 3 > fields.length) throw new Bolt11Error('Invoice is cut short.');
    const tag = fields[i];
    const len = fields[i + 1] * 32 + fields[i + 2];
    const data = fields.slice(i + 3, i + 3 + len);
    if (data.length !== len) throw new Bolt11Error('Invoice is cut short.');
    i += 3 + len;

    // The spec says to skip a p or h field of the wrong length, and to use
    // the first good one: a later duplicate can't replace it.
    switch (tag) {
      case TAG.paymentHash:
        if (len === 52 && !paymentHash) paymentHash = hex(data);
        break;
      case TAG.descriptionHash:
        if (len === 52 && !descriptionHash) descriptionHash = hex(data);
        break;
      case TAG.description:
        if (description === undefined) description = new TextDecoder('utf-8', { fatal: false }).decode(bytes(data));
        break;
      case TAG.expiry:
        expirySec = toInt(data);
        break;
    }
  }

  if (!paymentHash) throw new Bolt11Error('Invoice has no payment hash.');
  return { network, amountMsat, paymentHash, descriptionHash, description, createdAt, expiresAt: createdAt + expirySec };
}

function readPrefix(prefix: string) {
  if (!prefix.startsWith('ln')) throw new Bolt11Error('Not a Lightning invoice.');
  const rest = prefix.slice(2);
  const network = NETWORKS.find((n) => rest.startsWith(n));
  if (!network) throw new Bolt11Error('Unknown Lightning network.');

  const amount = rest.slice(network.length);
  if (!amount) return { network, amountMsat: undefined };

  const m = /^([1-9][0-9]*)([munp]?)$/.exec(amount);
  if (!m) throw new Bolt11Error('Invoice amount is malformed.');
  const n = BigInt(m[1]);
  const unit = m[2] as keyof typeof MSAT_PER;

  // A pico-bitcoin is a tenth of a msat; the spec only allows whole msats.
  let msat: bigint;
  if (unit === 'p') {
    if (n % 10n !== 0n) throw new Bolt11Error('Invoice amount is a fraction of a millisatoshi.');
    msat = n / 10n;
  } else {
    msat = n * MSAT_PER[unit];
  }
  if (msat > BigInt(Number.MAX_SAFE_INTEGER)) throw new Bolt11Error('Invoice amount is too large.');
  return { network, amountMsat: Number(msat) };
}

/** Big-endian, 5 bits a word. Only used on short fields (timestamp, expiry). */
function toInt(words: number[]) {
  if (words.length > 10) throw new Bolt11Error('Invoice field is too long.');
  return words.reduce((acc, w) => acc * 32 + w, 0);
}

/** 5-bit words to bytes, dropping the padding bits at the end. */
function bytes(words: number[]) {
  return bech32.fromWordsUnsafe(words) ?? Uint8Array.from(lossyFromWords(words));
}

function lossyFromWords(words: number[]) {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out;
}

function hex(words: number[]) {
  return Buffer.from(bytes(words)).toString('hex');
}
