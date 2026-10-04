import { describe, expect, it } from 'vitest';

import { parseUpiId, parseUpiResponse, upiPayUri } from './upi';

describe('parseUpiId', () => {
  it('takes the IDs people have, and lower-cases them', () => {
    expect(parseUpiId(' Om.Swami@okhdfcbank ')).toEqual({ ok: true, upiId: 'om.swami@okhdfcbank' });
    expect(parseUpiId('9876543210@ybl')).toEqual({ ok: true, upiId: '9876543210@ybl' });
    expect(parseUpiId('riya-01_x@paytm')).toEqual({ ok: true, upiId: 'riya-01_x@paytm' });
  });

  it('says so when it’s an email or a Lightning address', () => {
    const r = parseUpiId('om@walletofsatoshi.com');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/email or a Lightning address/);
  });

  it('turns away anything else that isn’t one', () => {
    for (const bad of ['', '   ', 'om', '@ybl', 'om@', 'om swami@ybl', 'om@@ybl', 'o@ybl', 'om@y', 'om@9bank']) {
      expect([bad, parseUpiId(bad).ok]).toEqual([bad, false]);
    }
  });
});

describe('upiPayUri', () => {
  it('names the payee, the amount in rupees, and the note', () => {
    expect(upiPayUri({ upiId: 'om@okhdfcbank', name: 'Om Swami', amount: 50000, note: 'Sattle Goa trip' })).toBe(
      'upi://pay?pa=om@okhdfcbank&pn=Om%20Swami&am=500.00&cu=INR&tn=Sattle%20Goa%20trip'
    );
  });

  it('keeps paise, and leaves the note out when there isn’t one', () => {
    expect(upiPayUri({ upiId: '9876543210@ybl', name: 'Riya', amount: 12345 })).toBe(
      'upi://pay?pa=9876543210@ybl&pn=Riya&am=123.45&cu=INR'
    );
  });

  it('strips what UPI apps choke on from the name and note, and keeps them short', () => {
    const uri = upiPayUri({ upiId: 'a.b@ybl', name: 'Zoë & “Friends” 🎉', amount: 100, note: `Flat #4B — ${'x'.repeat(80)}` });
    const q = new URLSearchParams(uri.slice('upi://pay?'.length));
    expect(q.get('pn')).toBe('Zoe Friends');
    expect(q.get('tn')).toMatch(/^Flat 4B x+$/);
    expect(q.get('tn')!.length).toBeLessThanOrEqual(50);
    expect(q.get('pa')).toBe('a.b@ybl');
  });
});

describe('parseUpiResponse', () => {
  it('reads the one-string form', () => {
    expect(parseUpiResponse('txnId=AXI123&responseCode=00&Status=SUCCESS&txnRef=T1&ApprovalRefNo=412345678901')).toEqual({
      status: 'success',
      reference: '412345678901',
    });
  });

  it('reads the string inside the extras, and fields sent on their own', () => {
    expect(parseUpiResponse({ response: 'txnId=P99&Status=FAILURE&ApprovalRefNo=null' })).toEqual({ status: 'failed', reference: 'P99' });
    expect(parseUpiResponse({ Status: 'success', txnRef: 'R7' })).toEqual({ status: 'success', reference: 'R7' });
    expect(parseUpiResponse({ status: 'SUBMITTED' })).toEqual({ status: 'pending' });
  });

  it('never calls silence a success', () => {
    for (const nothing of [null, undefined, '', {}, { response: '' }, 'Status=', { Status: 'undefined' }, { foo: 'SUCCESS' }]) {
      expect(parseUpiResponse(nothing).status).toBe('unknown');
    }
    expect(parseUpiResponse('Status=FAILED').status).toBe('failed');
    expect(parseUpiResponse('Status=successful').status).toBe('unknown');
  });
});
