/**
 * The LNURL client against stand-in servers. The answers are shaped like
 * the LUD-06/16/21 specs and the providers that follow them; a live check
 * against real addresses is `npm run lnurl:smoke`.
 */

import { createHash, randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { LnurlClient, LnurlError } from './lnurl';
import { SafeFetchError, type JsonResponse } from './safeFetch';
import { buildInvoice, hashWords, intWords } from './testing/invoices';

const NOW = 1_700_000_100_000; // just after the invoices' timestamp
const METADATA = '[["text/plain","Pay yash@wallet.example"],["text/identifier","yash@wallet.example"]]';
const PREIMAGE = randomBytes(32).toString('hex');
const HASH = createHash('sha256').update(Buffer.from(PREIMAGE, 'hex')).digest('hex');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A 10-sat (10,000 msat) invoice, as a well-behaved server would mint it. */
function invoice({ prefix = 'lnbc100n', hash = HASH, descriptionHash = sha(METADATA), expirySec = 600 } = {}) {
  return buildInvoice(prefix, [
    [1, hashWords(hash)],
    [23, hashWords(descriptionHash)],
    [6, intWords(expirySec)],
  ]);
}

const PARAMS_URL = 'https://wallet.example/.well-known/lnurlp/yash';
const CALLBACK = 'https://wallet.example/lnurlp/yash/callback?k=1';

let answers: Record<string, JsonResponse | Error>;
let requested: string[];

function client(opts: ConstructorParameters<typeof LnurlClient>[0] = {}) {
  return new LnurlClient({
    now: () => NOW,
    getJson: async (url) => {
      requested.push(url);
      const a = answers[url];
      if (!a) throw new SafeFetchError('NETWORK', 'no route');
      if (a instanceof Error) throw a;
      return a;
    },
    ...opts,
  });
}

const ok = (body: unknown): JsonResponse => ({ status: 200, body });
const payParams = (over: Record<string, unknown> = {}) =>
  ok({ tag: 'payRequest', callback: CALLBACK, minSendable: 1_000, maxSendable: 100_000_000, metadata: METADATA, ...over });
const callbackUrl = (msat: number) => `${CALLBACK}&amount=${msat}`;

beforeEach(() => {
  requested = [];
  answers = {
    [PARAMS_URL]: payParams(),
    [callbackUrl(10_000)]: ok({ pr: invoice(), routes: [], verify: 'https://wallet.example/verify/abc' }),
  };
});

async function refusal(p: Promise<unknown>) {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(LnurlError);
  return e as LnurlError;
}

describe('requestInvoice', () => {
  it('gets an invoice for exactly the amount, with its hash and verify link', async () => {
    const inv = await client().requestInvoice('Yash@Wallet.Example', 10_000);
    expect(inv).toEqual({
      invoice: invoice(),
      paymentHash: HASH,
      amountMsat: 10_000,
      expiresAt: 1_700_000_000 + 600,
      verifyUrl: 'https://wallet.example/verify/abc',
    });
    // The callback's own query is kept, ours added to it.
    expect(requested).toEqual([PARAMS_URL, callbackUrl(10_000)]);
  });

  it('has no verify link when the provider gives none, or gives a non-https one', async () => {
    answers[callbackUrl(10_000)] = ok({ pr: invoice() });
    expect((await client().requestInvoice('yash@wallet.example', 10_000)).verifyUrl).toBeUndefined();
    answers[callbackUrl(10_000)] = ok({ pr: invoice(), verify: 'http://wallet.example/verify/abc' });
    expect((await client().requestInvoice('yash@wallet.example', 10_000)).verifyUrl).toBeUndefined();
  });

  it('reuses the pay parameters for a while, then asks again', async () => {
    let now = NOW;
    const c = client({ now: () => now, cacheMs: 60_000 });
    await c.requestInvoice('yash@wallet.example', 10_000);
    await c.requestInvoice('yash@wallet.example', 10_000);
    expect(requested.filter((u) => u === PARAMS_URL)).toHaveLength(1);

    now += 61_000;
    answers[callbackUrl(10_000)] = ok({ pr: buildInvoice('lnbc100n', [[1, hashWords(HASH)], [23, hashWords(sha(METADATA))], [6, intWords(600)]], 1_700_000_060) });
    await c.requestInvoice('yash@wallet.example', 10_000);
    expect(requested.filter((u) => u === PARAMS_URL)).toHaveLength(2);
  });

  it('keeps the cache bounded', async () => {
    const c = client({ cacheEntries: 2 });
    for (const name of ['a', 'b', 'c']) answers[`https://wallet.example/.well-known/lnurlp/${name}`] = payParams();
    for (const name of ['a', 'b', 'c']) await c.payParams(`${name}@wallet.example`);
    await c.payParams('a@wallet.example'); // evicted, so fetched again
    expect(requested.filter((u) => u.endsWith('/lnurlp/a'))).toHaveLength(2);
  });

  it('refuses an amount outside the address’s limits, saying what they are', async () => {
    const e = await refusal(client().requestInvoice('yash@wallet.example', 500));
    expect(e.code).toBe('AMOUNT_OUT_OF_RANGE');
    expect(e.range).toEqual({ minMsat: 1_000, maxMsat: 100_000_000 });
    expect(requested).toEqual([PARAMS_URL]);
  });

  it.each([
    ['a different amount', { pr: invoice({ prefix: 'lnbc200n' }) }],
    ['no amount at all', { pr: invoice({ prefix: 'lnbc' }) }],
    ['another network', { pr: invoice({ prefix: 'lntb100n' }) }],
    ['a description hash for other metadata', { pr: invoice({ descriptionHash: sha('[["text/plain","someone else"]]') }) }],
    ['an expired invoice', { pr: invoice({ expirySec: 50 }) }],
    ['garbage', { pr: 'lnbc1notaninvoice' }],
  ])('refuses an invoice with %s', async (_, body) => {
    answers[callbackUrl(10_000)] = ok(body);
    expect((await refusal(client().requestInvoice('yash@wallet.example', 10_000))).code).toBe('BAD_INVOICE');
  });

  it('accepts a testnet invoice when that’s the network it runs on', async () => {
    answers[callbackUrl(10_000)] = ok({ pr: invoice({ prefix: 'lntbs100n' }) });
    expect((await client({ network: 'tbs' }).requestInvoice('yash@wallet.example', 10_000)).amountMsat).toBe(10_000);
  });

  it('passes on the provider’s own reason, cleaned and cut short', async () => {
    answers[PARAMS_URL] = ok({ status: 'ERROR', reason: `User not found <script>\n${'x'.repeat(300)}` });
    const e = await refusal(client().requestInvoice('yash@wallet.example', 10_000));
    expect(e.code).toBe('PROVIDER_ERROR');
    expect(e.message.startsWith('User not found script')).toBe(true);
    expect(e.message.length).toBeLessThanOrEqual(120);
  });

  it('treats an ERROR from the callback, or a 404, as the provider refusing', async () => {
    answers[callbackUrl(10_000)] = { status: 400, body: { status: 'ERROR', reason: 'Amount too small' } };
    expect(await refusal(client().requestInvoice('yash@wallet.example', 10_000))).toMatchObject({ code: 'PROVIDER_ERROR', message: 'Amount too small' });
    answers[PARAMS_URL] = { status: 404, body: {} };
    expect((await refusal(client().requestInvoice('yash@wallet.example', 10_000))).code).toBe('PROVIDER_ERROR');
  });

  it.each([
    ['not a pay request', { tag: 'withdrawRequest' }],
    ['an http callback', { callback: 'http://wallet.example/cb' }],
    ['min above max', { minSendable: 10_000, maxSendable: 1_000 }],
    ['fractional limits', { minSendable: 1.5 }],
    ['metadata that isn’t a JSON array', { metadata: '{"text":"hi"}' }],
    ['no metadata', { metadata: undefined }],
  ])('refuses pay parameters with %s', async (_, over) => {
    answers[PARAMS_URL] = payParams(over);
    expect((await refusal(client().requestInvoice('yash@wallet.example', 10_000))).code).toBe('BAD_RESPONSE');
  });

  it('refuses a callback answer with no invoice', async () => {
    answers[callbackUrl(10_000)] = ok({ routes: [] });
    expect((await refusal(client().requestInvoice('yash@wallet.example', 10_000))).code).toBe('BAD_RESPONSE');
  });

  it('says unreachable for network trouble, and bad response for junk', async () => {
    answers[PARAMS_URL] = new SafeFetchError('TIMEOUT', 'slow');
    expect((await refusal(client().requestInvoice('yash@wallet.example', 10_000))).code).toBe('UNREACHABLE');
    answers[PARAMS_URL] = new SafeFetchError('BLOCKED_ADDRESS', 'private');
    expect((await refusal(client().requestInvoice('yash@wallet.example', 10_000))).code).toBe('UNREACHABLE');
    answers[PARAMS_URL] = new SafeFetchError('BAD_JSON', 'html');
    expect((await refusal(client().requestInvoice('yash@wallet.example', 10_000))).code).toBe('BAD_RESPONSE');
  });

  it('refuses something that isn’t an address before going anywhere', async () => {
    expect((await refusal(client().requestInvoice('lnbc1abc', 10_000))).code).toBe('INVALID_ADDRESS');
    expect(requested).toEqual([]);
  });
});

describe('verify', () => {
  const VERIFY = 'https://wallet.example/verify/abc';

  it('is paid only with a preimage for this invoice', async () => {
    answers[VERIFY] = ok({ status: 'OK', settled: true, preimage: PREIMAGE.toUpperCase(), pr: invoice() });
    expect(await client().verify(VERIFY, HASH)).toEqual({ settled: true, preimage: PREIMAGE });
  });

  it('is not paid while pending', async () => {
    answers[VERIFY] = ok({ status: 'OK', settled: false, preimage: null, pr: invoice() });
    expect(await client().verify(VERIFY, HASH)).toEqual({ settled: false });
  });

  it('doesn’t take "settled" on the provider’s word without a matching preimage', async () => {
    answers[VERIFY] = ok({ status: 'OK', settled: true, preimage: null });
    expect(await client().verify(VERIFY, HASH)).toEqual({ settled: false });
    answers[VERIFY] = ok({ status: 'OK', settled: true, preimage: randomBytes(32).toString('hex') });
    expect(await client().verify(VERIFY, HASH)).toEqual({ settled: false });
  });

  it('throws, rather than saying unpaid, when the provider can’t be asked', async () => {
    answers[VERIFY] = new SafeFetchError('TIMEOUT', 'slow');
    expect((await refusal(client().verify(VERIFY, HASH))).code).toBe('UNREACHABLE');
  });
});
