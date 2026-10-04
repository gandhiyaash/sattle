import { describe, expect, it } from 'vitest';

import type { ReceiveAddress } from '@sattle/core';

import { createApp } from './app';
import { openDb, seedIfEmpty } from './db';
import { LnurlError, type LnurlClient } from './lnurl';
import { SimulatedPayments } from './payments';

function setup(payParams?: LnurlClient['payParams']) {
  const db = openDb(':memory:');
  seedIfEmpty(db);
  const checked: string[] = [];
  const app = createApp({
    db,
    demoUserId: 'u-yash',
    payments: (repo) => new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
    lnurl: payParams
      ? {
          payParams: (a) => {
            checked.push(a);
            return payParams(a);
          },
        }
      : undefined,
  });
  async function call<T = ReceiveAddress & { code?: string; message?: string }>(method: string, body?: unknown) {
    const res = await app.request('/me/receive-address', {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }
  return { db, call, checked };
}

const answers = async () => ({ callback: 'https://w.example/cb', minSendableMsat: 1_000, maxSendableMsat: 1e9, metadata: '[]' });

describe('/me/receive-address', () => {
  it('starts empty, is set after the address answers, and can be cleared', async () => {
    const { call, checked } = setup(answers);
    expect((await call('GET')).body).toEqual({ address: null });

    const set = await call('PUT', { address: ' lightning:Yash@Blink.SV ' });
    expect(set).toEqual({ status: 200, body: { address: 'yash@blink.sv' } });
    expect(checked).toEqual(['yash@blink.sv']);
    expect((await call('GET')).body).toEqual({ address: 'yash@blink.sv' });

    expect((await call('DELETE')).body).toEqual({ address: null });
    expect((await call('GET')).body).toEqual({ address: null });
  });

  it('refuses something that isn’t an address without asking anyone', async () => {
    const { call, checked } = setup(answers);
    const res = await call('PUT', { address: 'lnbc10n1pinvoice' });
    expect(res).toMatchObject({ status: 400, body: { code: 'invalid_address' } });
    expect(checked).toEqual([]);
  });

  it.each([
    [new LnurlError('UNREACHABLE', 'x'), 503, 'network', 'That address didn’t answer. Check it’s right, or try again in a minute.'],
    [new LnurlError('PROVIDER_ERROR', 'No such user'), 400, 'invalid_address', 'That address’s wallet said: No such user'],
    [new LnurlError('BAD_RESPONSE', 'x'), 400, 'invalid_address', 'That address can’t receive payments. Check it’s right.'],
  ])('doesn’t save an address that doesn’t work (%s)', async (error, status, code, message) => {
    const { call } = setup(async () => {
      throw error;
    });
    expect(await call('PUT', { address: 'yash@blink.sv' })).toEqual({ status, body: { code, message } });
    expect((await call('GET')).body).toEqual({ address: null });
  });

  it('keeps a well-formed address unchecked when payments are simulated', async () => {
    const { call } = setup();
    expect((await call('PUT', { address: 'yash@blink.sv' })).body).toEqual({ address: 'yash@blink.sv' });
  });
});
