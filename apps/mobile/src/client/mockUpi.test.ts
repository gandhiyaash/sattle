import { describe, expect, it } from 'vitest';

import { MockClient } from './MockClient';

const client = () => new MockClient({ latencyMs: 0 });

/** In the demo's Goa trip Yash, the mock's one user, owes Om, who takes UPI. */
const yashOwesOm = async (c: MockClient) =>
  (await c.getDebts('g-goa')).find((d) => d.fromMemberId === 'm-goa-yash' && d.toMemberId === 'm-goa-om')!;

describe('MockClient UPI', () => {
  it('keeps the user’s own UPI ID, and turns away what isn’t one', async () => {
    const c = client();
    expect(await c.getUpiId()).toEqual({ upiId: null, onGroupLinks: true });
    expect(await c.setUpiId(' Yash@OkAxis ')).toEqual({ upiId: 'yash@okaxis', onGroupLinks: true });
    expect(await c.getUpiId()).toEqual({ upiId: 'yash@okaxis', onGroupLinks: true });
    await expect(c.setUpiId('yash@walletofsatoshi.com')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await c.clearUpiId()).toEqual({ upiId: null, onGroupLinks: true });
  });

  it('says who takes UPI in the member list, and gives the ID only to someone who owes them', async () => {
    const c = client();
    const members = await c.getMembers('g-goa');
    expect(members.filter((m) => m.upi).map((m) => m.id)).toEqual(['m-goa-om']);
    expect(JSON.stringify(members)).not.toContain('okhdfcbank');

    expect(await c.getUpiPayee('g-goa', 'm-goa-om')).toEqual({ upiId: 'om@okhdfcbank', name: 'Om' });
    await expect(c.getUpiPayee('g-goa', 'm-goa-yash')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('records a claim without moving the balance, one per debt', async () => {
    const c = client();
    const debt = await yashOwesOm(c);
    const input = { groupId: 'g-goa', fromMemberId: debt.fromMemberId, toMemberId: debt.toMemberId, amount: debt.amount };

    const first = await c.createUpiClaim({ ...input, reference: ' 4123 ' });
    expect(first).toMatchObject({ ...input, reference: '4123', status: 'pending' });
    expect((await yashOwesOm(c)).amount).toBe(debt.amount);

    const second = await c.createUpiClaim(input);
    expect(second).not.toHaveProperty('reference');
    expect(await c.getUpiClaims('g-goa')).toEqual([second]);
  });

  it('refuses a claim for more than is owed, or to someone with no UPI ID', async () => {
    const c = client();
    const debt = await yashOwesOm(c);
    const input = { groupId: 'g-goa', fromMemberId: debt.fromMemberId, toMemberId: debt.toMemberId };
    await expect(c.createUpiClaim({ ...input, amount: debt.amount + 1 })).rejects.toMatchObject({ code: 'conflict' });

    const toAman = (await c.getDebts('g-goa')).find((d) => d.fromMemberId === 'm-goa-yash' && d.toMemberId === 'm-goa-aman');
    if (toAman) {
      await expect(c.createUpiClaim({ ...toAman, groupId: 'g-goa' })).rejects.toMatchObject({ code: 'member_cannot_receive' });
    }
    expect(await c.getUpiClaims('g-goa')).toEqual([]);
  });

  it('leaves confirming and declining to the person owed, and taking back to the payer', async () => {
    const c = client();
    const debt = await yashOwesOm(c);
    const claim = await c.createUpiClaim({ groupId: 'g-goa', fromMemberId: debt.fromMemberId, toMemberId: debt.toMemberId, amount: debt.amount });

    // Yash made it; Om is the one owed, and Om isn't here.
    await expect(c.confirmUpiClaim(claim.id)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(c.declineUpiClaim(claim.id)).rejects.toMatchObject({ code: 'invalid_input' });
    await c.withdrawUpiClaim(claim.id);
    expect(await c.getUpiClaims('g-goa')).toEqual([]);
    await expect(c.withdrawUpiClaim(claim.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('won’t start a direct payment on the UPI rail', async () => {
    const c = client();
    const debt = await yashOwesOm(c);
    await expect(
      c.createSettlement({ groupId: 'g-goa', fromMemberId: debt.fromMemberId, toMemberId: debt.toMemberId, amount: debt.amount, rail: 'upi' })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('MockClient: a pay link paid by UPI', () => {
  /** Priya owes Yash ₹1,200 in Flat 4B. Not Om's debt: the seeded demo invoice is out for that one. */
  const linkToPriya = async (c: MockClient) => {
    const debt = (await c.getDebts('g-flat')).find((d) => d.fromMemberId === 'm-flat-priya' && d.toMemberId === 'm-flat-yash')!;
    const { groupId, fromMemberId, toMemberId, amount } = debt;
    return c.createPayLink({ groupId, fromMemberId, toMemberId, amount });
  };

  it('opens straight on an invoice while Lightning is the only way to pay it', async () => {
    const c = client();
    const { token, amount } = await linkToPriya(c);
    const view = await c.openPayLink(token);
    expect(view).toMatchObject({ amount, currency: 'INR', payable: true });
    expect(view.upi).toBeUndefined();
    expect(view.settlement).toBeDefined();
  });

  it('asks which way once the person owed takes UPI too, and mints only when Lightning is chosen', async () => {
    const c = client();
    await c.setUpiId('yash@okaxis');
    const { token } = await linkToPriya(c);

    const asked = await c.openPayLink(token);
    expect(asked).toMatchObject({ payable: true, upi: true });
    expect(asked.settlement).toBeUndefined();
    expect(await c.getPayLinkUpi(token)).toEqual({ upiId: 'yash@okaxis', name: 'Yash' });

    expect((await c.openPayLink(token, 'lightning')).settlement).toBeDefined();
    // With that invoice out, UPI waits: the two together could pay it twice.
    await expect(c.claimUpiFromPayLink(token)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('lets the page say it was paid, and shows the link paid once the person owed confirms', async () => {
    const c = client();
    await c.setUpiId('yash@okaxis');
    const { token, amount } = await linkToPriya(c);

    await c.claimUpiFromPayLink(token);
    const [claim] = await c.getUpiClaims('g-flat');
    expect(claim).toMatchObject({ fromMemberId: 'm-flat-priya', toMemberId: 'm-flat-yash', amount, status: 'pending', viaLink: true });
    // Nothing is minted while that waits, whichever way is asked for.
    expect(await c.openPayLink(token, 'lightning')).toMatchObject({ upiClaim: 'pending', settlement: undefined });

    const settled = await c.confirmUpiClaim(claim.id);
    const paid = await c.openPayLink(token);
    expect(paid.settlement).toMatchObject({ id: settled.id, status: 'manually_confirmed' });
    expect(paid.upiClaim).toBeUndefined();
    await expect(c.claimUpiFromPayLink(token)).rejects.toMatchObject({ code: 'link_expired' });
  });

  it('shows the link settled once the person owed marks it settled, with the UPI payment they were told of gone', async () => {
    const c = client();
    await c.setUpiId('yash@okaxis');
    const { token, groupId, fromMemberId, toMemberId, amount } = await linkToPriya(c);
    await c.claimUpiFromPayLink(token);

    await c.markSettledManually({ groupId, fromMemberId, toMemberId, amount, note: 'cash' });
    expect(await c.getUpiClaims('g-flat')).toEqual([]);
    const view = await c.getGuestView(token);
    expect(view.settlement).toMatchObject({ amount, status: 'manually_confirmed' });
    expect(view.upiClaim).toBeUndefined();
    expect((await c.openPayLink(token)).settlement?.status).toBe('manually_confirmed');
    await expect(c.claimUpiFromPayLink(token)).rejects.toMatchObject({ code: 'link_expired' });
  });

  it('won’t be marked settled while an invoice for it can still be paid', async () => {
    const c = client();
    const { token, groupId, fromMemberId, toMemberId, amount } = await linkToPriya(c);
    expect((await c.openPayLink(token)).settlement).toBeDefined();
    await expect(c.markSettledManually({ groupId, fromMemberId, toMemberId, amount })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('shows the person owed turning it down, and can be said again', async () => {
    const c = client();
    await c.setUpiId('yash@okaxis');
    const { token } = await linkToPriya(c);
    await c.claimUpiFromPayLink(token);
    await c.declineUpiClaim((await c.getUpiClaims('g-flat'))[0].id);
    expect((await c.openPayLink(token)).upiClaim).toBe('declined');

    await c.claimUpiFromPayLink(token);
    expect((await c.getGuestView(token)).upiClaim).toBe('pending');
  });

  it('doesn’t offer UPI once it is turned off for shared links', async () => {
    const c = client();
    await c.setUpiId('yash@okaxis');
    await c.setUpiOnGroupLinks(false);
    const { token } = await linkToPriya(c);

    const view = await c.openPayLink(token);
    expect(view.upi).toBeUndefined();
    expect(view.settlement).toBeDefined();
    await expect(c.getPayLinkUpi(token)).rejects.toMatchObject({ code: 'member_cannot_receive' });
  });
});

describe('MockClient: a UPI payment the payer’s UPI app reported', () => {
  it('settles the debt on the spot, keeps the ids the app gave, and shows them in the history', async () => {
    const c = client();
    const debt = await yashOwesOm(c);
    const { groupId, fromMemberId, toMemberId, amount } = debt;

    const paid = await c.reportUpiPayment({ groupId, fromMemberId, toMemberId, amount, txnId: 'AXI8f2c9d', approvalRef: '412345678901', txnRef: '  ' });
    expect(paid).toMatchObject({ rail: 'upi', status: 'manually_confirmed', amount, note: 'Paid by UPI', recordedByMemberId: 'm-goa-yash' });
    // The link's own reference came back blank, so it isn't kept.
    expect(paid.upi).toEqual({ txnId: 'AXI8f2c9d', approvalRef: '412345678901' });

    expect(await yashOwesOm(c)).toBeUndefined();
    expect(await c.getUpiClaims('g-goa')).toEqual([]);
    expect((await c.getHistory('g-goa'))[0]).toMatchObject({ kind: 'settled', byMemberId: 'm-goa-yash', settlement: { id: paid.id, upi: paid.upi } });
  });

  it('settles the same way on the payer’s own word, with the reference they typed in', async () => {
    const c = client();
    const { groupId, fromMemberId, toMemberId, amount } = await yashOwesOm(c);

    // What couldn't be a reference settles nothing.
    await expect(c.reportUpiPayment({ groupId, fromMemberId, toMemberId, amount, reference: 'it went through' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect((await yashOwesOm(c)).amount).toBe(amount);

    // Yes with nothing typed: his word alone, kept as that.
    const bare = await c.reportUpiPayment({ groupId, fromMemberId, toMemberId, amount: 100, byPayer: true, reference: '  ' });
    expect(bare.upi).toEqual({ byPayer: true });

    const paid = await c.reportUpiPayment({ groupId, fromMemberId, toMemberId, amount: amount - 100, byPayer: true, reference: ' 4123 4567 8901 ' });
    expect(paid).toMatchObject({ rail: 'upi', status: 'manually_confirmed', recordedByMemberId: 'm-goa-yash' });
    expect(paid.upi).toEqual({ byPayer: true, reference: '412345678901' });
    expect(await yashOwesOm(c)).toBeUndefined();
  });

  it('keeps which app it was paid in, when the phone names one', async () => {
    const c = client();
    const { groupId, fromMemberId, toMemberId, amount } = await yashOwesOm(c);
    const byApp = await c.reportUpiPayment({ groupId, fromMemberId, toMemberId, amount: 100, txnId: 'AXI1', paidWith: 'CRED' });
    expect(byApp.upi).toEqual({ txnId: 'AXI1', paidWith: 'CRED' });
    // By hand, in an app opened plain: no ids and no reference, but still the app.
    const byHand = await c.reportUpiPayment({ groupId, fromMemberId, toMemberId, amount: amount - 100, byPayer: true, paidWith: ' Google Pay ' });
    expect(byHand.upi).toEqual({ byPayer: true, paidWith: 'Google Pay' });
    expect(await yashOwesOm(c)).toBeUndefined();
  });

  it('takes the place of a claim that was waiting, and follows the same rules as one', async () => {
    const c = client();
    const { groupId, fromMemberId, toMemberId, amount } = await yashOwesOm(c);
    await c.createUpiClaim({ groupId, fromMemberId, toMemberId, amount });
    await expect(c.reportUpiPayment({ groupId, fromMemberId, toMemberId, amount: amount + 1, txnId: 'AXI1' })).rejects.toMatchObject({ code: 'conflict' });

    await c.reportUpiPayment({ groupId, fromMemberId, toMemberId, amount, txnId: 'AXI1' });
    expect(await c.getUpiClaims('g-goa')).toEqual([]);
    // Aman is owed too, and has no UPI ID to have been paid at.
    const toAman = (await c.getDebts('g-goa')).find((d) => d.fromMemberId === 'm-goa-yash' && d.toMemberId === 'm-goa-aman')!;
    await expect(
      c.reportUpiPayment({ groupId, fromMemberId, toMemberId: 'm-goa-aman', amount: toAman.amount, txnId: 'AXI2' })
    ).rejects.toMatchObject({ code: 'member_cannot_receive' });
  });
});
