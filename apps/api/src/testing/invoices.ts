/**
 * Builds BOLT11 invoices for tests, with a dummy signature: the decoder
 * doesn't check it. Tag numbers are from the spec: 1 payment hash,
 * 6 expiry, 13 description, 23 description hash.
 */

import { bech32 } from '@scure/base';

export function buildInvoice(prefix: string, fields: [tag: number, data: number[]][], timestamp = 1_700_000_000) {
  const ts: number[] = [];
  for (let i = 6, t = timestamp; i >= 0; i--, t = Math.floor(t / 32)) ts[i] = t % 32;
  const body = fields.flatMap(([tag, data]) => [tag, data.length >> 5, data.length & 31, ...data]);
  return bech32.encode(prefix, [...ts, ...body, ...new Array(104).fill(0)], false);
}

export const hashWords = (hex: string) => bech32.toWords(Buffer.from(hex, 'hex'));

export const intWords = (n: number) => {
  const out: number[] = [];
  do out.unshift(n % 32);
  while ((n = Math.floor(n / 32)) > 0);
  return out;
};
