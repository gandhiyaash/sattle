import { createHash } from 'node:crypto';

import { bech32 } from '@scure/base';
import { describe, expect, it } from 'vitest';

import { Bolt11Error, decodeBolt11 } from './bolt11';

/** From the BOLT11 spec: "Please send $3 for a cup of coffee to the same peer, within one minute". */
const SPEC_COFFEE =
  'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh';

const HASH = '0001020304050607080900010203040506070809000102030405060708090102';

/** Builds an invoice from fields, with a dummy signature: the decoder doesn't check it. */
function invoice(prefix: string, fields: [tag: number, data: number[]][], timestamp = 1_700_000_000) {
  const ts: number[] = [];
  for (let i = 6, t = timestamp; i >= 0; i--, t = Math.floor(t / 32)) ts[i] = t % 32;
  const body = fields.flatMap(([tag, data]) => [tag, data.length >> 5, data.length & 31, ...data]);
  return bech32.encode(prefix, [...ts, ...body, ...new Array(104).fill(0)], false);
}
const hashWords = (hex: string) => bech32.toWords(Buffer.from(hex, 'hex'));
const intWords = (n: number) => {
  const out: number[] = [];
  do out.unshift(n % 32);
  while ((n = Math.floor(n / 32)) > 0);
  return out;
};

describe('decodeBolt11', () => {
  it('reads the spec’s example invoice', () => {
    expect(decodeBolt11(SPEC_COFFEE)).toEqual({
      network: 'bc',
      amountMsat: 250_000_000,
      paymentHash: HASH,
      descriptionHash: undefined,
      description: '1 cup coffee',
      createdAt: 1496314658,
      expiresAt: 1496314658 + 60,
    });
  });

  it('accepts it uppercase or behind lightning:, as wallets share it', () => {
    expect(decodeBolt11(`lightning:${SPEC_COFFEE.toUpperCase()}`).paymentHash).toBe(HASH);
  });

  it('reads the description hash LNURL-pay commits to, and defaults expiry to an hour', () => {
    const metadata = '[["text/plain","Sattle"]]';
    const h = createHash('sha256').update(metadata).digest('hex');
    const inv = decodeBolt11(invoice('lnbc10n', [[1, hashWords(HASH)], [23, hashWords(h)]]));
    expect(inv).toMatchObject({ amountMsat: 1_000, paymentHash: HASH, descriptionHash: h, expiresAt: 1_700_000_000 + 3600 });
  });

  it.each([
    ['lnbc1', 100_000_000_000],
    ['lnbc1m', 100_000_000],
    ['lnbc1u', 100_000],
    ['lnbc1n', 100],
    ['lnbc10p', 1],
    ['lntb20u', 2_000_000],
    ['lntbs3n', 300],
    ['lnbcrt5u', 500_000],
  ])('reads %s as %d msat', (prefix, msat) => {
    expect(decodeBolt11(invoice(prefix, [[1, hashWords(HASH)]])).amountMsat).toBe(msat);
  });

  it('names the network, and leaves the amount out when the payer chooses it', () => {
    expect(decodeBolt11(invoice('lntbs', [[1, hashWords(HASH)]]))).toMatchObject({ network: 'tbs', amountMsat: undefined });
    expect(decodeBolt11(invoice('lnbcrt', [[1, hashWords(HASH)]]))).toMatchObject({ network: 'bcrt' });
  });

  it('keeps the first good payment hash: a later or malformed one can’t replace it', () => {
    const other = 'ff'.repeat(32);
    const inv = decodeBolt11(invoice('lnbc1n', [[1, hashWords(HASH).slice(0, 40)], [1, hashWords(HASH)], [1, hashWords(other)]]));
    expect(inv.paymentHash).toBe(HASH);
  });

  it('reads a custom expiry', () => {
    expect(decodeBolt11(invoice('lnbc1n', [[1, hashWords(HASH)], [6, intWords(600)]])).expiresAt).toBe(1_700_000_000 + 600);
  });

  it.each([
    ['not bech32', 'lnbc1nothing'],
    ['a bad checksum', SPEC_COFFEE.slice(0, -1) + (SPEC_COFFEE.endsWith('h') ? 'g' : 'h')],
    ['an address, not an invoice', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'],
    ['an unknown network', invoice('lnxx1n', [[1, hashWords(HASH)]])],
    ['a fraction of a msat', invoice('lnbc1p', [[1, hashWords(HASH)]])],
    ['a leading zero in the amount', invoice('lnbc01n', [[1, hashWords(HASH)]])],
    ['no payment hash', invoice('lnbc1n', [[13, bech32.toWords(Buffer.from('hi'))]])],
  ])('refuses %s', (_, raw) => {
    expect(() => decodeBolt11(raw)).toThrow(Bolt11Error);
  });
});
