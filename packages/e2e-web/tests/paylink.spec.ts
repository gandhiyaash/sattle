/**
 * Pay links: one debt, paid by whoever opens /s/<token> with no app and no
 * account. Nobody sends one by hand: the group's page hands one out for a
 * debt on it, and that is how each of these is had (Api.payLinkFor). The
 * pay page in every state it can be in (a fresh invoice, the proof box,
 * paid, settled some other way, nothing left to pay, a dead link), two
 * devices on one link, paying it by UPI, and a link in a group kept in
 * bitcoin.
 */

import type { Page } from '@playwright/test';

import { ancestor, button, clipboard, groupTab, openGroup, tokenOf } from '../src/actions';
import { expect, test } from '../src/fixtures';
import { groupWhereGhostOwesMe, openPayPage } from '../src/links.helpers';

/**
 * Keeps the page from hearing that the payment went through, so a state
 * that lasts a second can be looked at for as long as the test likes. The
 * page's own poll of the link is dropped; everything else goes through.
 */
async function holdPolling(page: Page, token: string) {
  let hold = true;
  await page.route(
    (u) => u.pathname === `/s/${token}`,
    (route) => (hold && route.request().method() === 'GET' ? route.abort() : route.continue())
  );
  return () => {
    hold = false;
  };
}

test.describe('The pay page', () => {
  test('shows who owes whom, mints a fresh invoice, takes a proof, and shows the payment once it lands', async ({
    person,
    device,
  }) => {
    test.slow();
    const yash = await person('Yash');
    const { group } = await groupWhereGhostOwesMe(yash.api, { name: 'Goa trip', me: 'Yash', debtor: 'Om' });
    const link = await yash.api.payLinkFor(group.id, 'Om', 'Yash');

    const guest = await device({ toured: false });
    await guest.page.goto(`/s/${link.token}`);
    await expect(guest.page.getByText('Sattle', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Om, you owe Yash')).toBeVisible();
    await expect(guest.page.getByText('Goa trip', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('No account needed. Only this payment is shown, not the group.')).toBeVisible();
    await expect(guest.page.getByText('Getting a fresh invoice…')).toBeVisible();
    // No tour, nothing of the app.
    await expect(guest.page.getByText('Skip', { exact: true })).toBeHidden();

    await expect(button(guest.page, 'Open your wallet')).toBeVisible({ timeout: 15_000 });
    const release = await holdPolling(guest.page, link.token);
    await expect(guest.page.getByText('₹300', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('3,333 sats', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Exchange rate', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('1 BTC = ₹90,00,000')).toBeVisible();
    await expect(guest.page.getByText('Demo rate. No real money moves')).toBeVisible();
    await expect(guest.page.getByText(/≈ \d+ sats, paid on top/)).toBeVisible();
    await expect(guest.page.getByText('Works with any Lightning wallet.')).toBeVisible();
    await expect(guest.page.locator('svg path[fill="#000000"]').first()).toBeVisible();
    await expect(guest.page.getByText(/^Rate and invoice locked for 1:[0-5]\d$/)).toBeVisible();
    await expect(guest.page.getByText('Pay with your browser wallet')).toBeHidden();

    await button(guest.page, 'Copy invoice').click();
    await expect(guest.page.getByText('Copied.', { exact: true })).toBeVisible();
    expect(await clipboard(guest.page)).toMatch(/^lnbc\d+n1sim/);

    await button(guest.page, 'Already paid? Send your payment proof').click();
    await expect(guest.page.getByText('Your payment proof')).toBeVisible();
    await expect(
      guest.page.getByText(
        'Your wallet shows it in the payment’s details, sometimes called the preimage: 64 letters and numbers. Only the wallet that paid has it, so it shows this was paid.'
      )
    ).toBeVisible();
    const proof = guest.page.getByPlaceholder('Paste it here');
    await expect(ancestor(button(guest.page, 'Send proof'), 1)).toHaveCSS('opacity', '0.4');
    await proof.fill('abc');
    await button(guest.page, 'Send proof').click();
    await expect(
      guest.page.getByText(
        'That isn’t a payment proof. It’s 64 characters of 0–9 and a–f, from your wallet’s payment details.'
      )
    ).toBeVisible();
    await proof.fill('0'.repeat(64));
    await button(guest.page, 'Send proof').click();
    await expect(guest.page.getByText('That proof is for a different payment.')).toBeVisible();

    release();
    await expect(guest.page.getByText('Paid', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(guest.page.getByText('✓')).toBeVisible();
    await expect(guest.page.getByText('Yash has been paid. Nothing else to do — you can close this.')).toBeVisible();
    for (const label of ['Amount', 'Sent', 'Exchange rate', 'Payment proof']) {
      await expect(guest.page.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(guest.page.getByText('3,333 sats', { exact: true })).toBeVisible();
    await expect(guest.page.getByText(/^[0-9a-f]{64}$/)).toBeVisible();
    await expect(button(guest.page, 'Open your wallet')).toBeHidden();

    await guest.page.reload();
    await expect(guest.page.getByText('Paid', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Yash has been paid. Nothing else to do — you can close this.')).toBeVisible();

    await openGroup(yash.page, 'Goa trip', { reload: true });
    await expect(yash.page.getByText('All settled', { exact: true })).toBeVisible();
    await groupTab(yash.page, 'Settle up');
    await expect(yash.page.getByText('All settled.', { exact: true })).toBeVisible();
    await button(yash.page, 'History').click();
    await expect(yash.page.getByText('Om paid Yash', { exact: true })).toBeVisible();
    await expect(yash.page.getByText(/^Paid over Lightning · /)).toBeVisible();
  });

  test('two devices on one link see one payment', async ({ api, device }) => {
    test.slow();
    const yash = api.as((await api.account('Yash')).token);
    const { group } = await groupWhereGhostOwesMe(yash, { name: 'Goa trip', me: 'Yash', debtor: 'Om' });
    const link = await yash.payLinkFor(group.id, 'Om', 'Yash');
    const phone = await device();
    const laptop = await device();
    await openPayPage(phone.page, link.token);
    await openPayPage(laptop.page, link.token);
    for (const { page } of [phone, laptop]) {
      await expect(page.getByText('Paid', { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('Yash has been paid. Nothing else to do — you can close this.')).toBeVisible();
    }
    const settlements = await yash.settlements(group.id);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ status: 'confirmed', rail: 'invoice', amount: 30_000 });
  });

  test('a link nobody made, a debt settled meanwhile, a debt that is gone, and a debt paid through another link', async ({
    api,
    device,
  }) => {
    test.slow();
    const yash = api.as((await api.account('Yash')).token);
    const guest = await device();

    await guest.page.goto('/s/not-a-link-anyone-made');
    await expect(guest.page.getByText('This link isn’t valid')).toBeVisible();
    await expect(guest.page.getByText('Check you copied all of it, or ask whoever sent it for a new one.')).toBeVisible();

    // Marked settled in the app before the link was opened.
    const settled = await groupWhereGhostOwesMe(yash, { name: 'Settled trip', me: 'Yash', debtor: 'Om' });
    const forSettled = await yash.payLinkFor(settled.group.id, 'Om', 'Yash');
    await yash.markSettled({ groupId: settled.group.id, fromMemberId: settled.idOf('Om'), toMemberId: settled.idOf('Yash'), amount: 30_000 });
    await openPayPage(guest.page, forSettled.token);
    await expect(guest.page.getByText('Settled', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('This has been settled. Nothing else to do — you can close this.')).toBeVisible();
    await expect(guest.page.getByText('Amount', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Payment proof', { exact: true })).toBeHidden();

    // The expense behind the debt was removed: nothing is owed, so there's nothing to pay.
    const gone = await groupWhereGhostOwesMe(yash, { name: 'Gone trip', me: 'Yash', debtor: 'Om' });
    const forGone = await yash.payLinkFor(gone.group.id, 'Om', 'Yash');
    await yash.del(`/groups/${gone.group.id}/expenses/${gone.expenses[0].id}`);
    await openPayPage(guest.page, forGone.token);
    await expect(guest.page.getByText('Nothing to pay')).toBeVisible();
    await expect(guest.page.getByText('You can close this.')).toBeVisible();

    // Paid through a second link, handed out once Om owed more: the first shows that payment,
    // without the second link's receipt.
    const twice = await groupWhereGhostOwesMe(yash, { name: 'Twice trip', me: 'Yash', debtor: 'Om' });
    const first = await yash.payLinkFor(twice.group.id, 'Om', 'Yash');
    await yash.addExpense({
      groupId: twice.group.id,
      description: 'Cab',
      amount: 20_000,
      paidByMemberId: twice.idOf('Yash'),
      splitMode: 'equal',
      parts: [{ memberId: twice.idOf('Yash') }, { memberId: twice.idOf('Om') }],
    });
    const second = await yash.payLinkFor(twice.group.id, 'Om', 'Yash');
    expect(second.token).not.toBe(first.token);
    const payer = await device();
    await openPayPage(payer.page, second.token);
    await expect(payer.page.getByText('Paid', { exact: true })).toBeVisible({ timeout: 20_000 });
    await openPayPage(guest.page, first.token);
    await expect(guest.page.getByText('Paid', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Yash has been paid. Nothing else to do — you can close this.')).toBeVisible();
    await expect(guest.page.getByText('Sent', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Payment proof', { exact: true })).toBeHidden();
    expect(await yash.settlements(twice.group.id)).toHaveLength(1);
  });
});

test.describe('A pay link paid by UPI', () => {
  test('asks which way, mints nothing until told, and waits for the person owed to confirm', async ({ person, device, api }) => {
    test.slow();
    const yash = await person('Yash');
    const { group } = await groupWhereGhostOwesMe(yash.api, { name: 'Goa trip', me: 'Yash', debtor: 'Om' });
    await yash.api.setUpiId('yash@okaxis');
    const link = await yash.api.payLinkFor(group.id, 'Om', 'Yash');

    const guest = await device();
    await openPayPage(guest.page, link.token);
    await expect(guest.page.getByText('Om, you owe Yash')).toBeVisible();
    await expect(button(guest.page, 'Pay by UPI')).toBeVisible();
    await expect(guest.page.getByText('GPay, PhonePe or any UPI app', { exact: true })).toBeVisible();
    await expect(button(guest.page, 'Pay with Lightning')).toBeVisible();
    await expect(guest.page.getByText('Any Lightning wallet', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Getting a fresh invoice…')).toBeHidden();
    expect((await api.guestView(link.token)).settlement).toBeUndefined();

    await button(guest.page, 'Pay by UPI').click();
    await expect(guest.page.getByText('Yash’s UPI ID')).toBeVisible();
    await expect(guest.page.getByText('yash@okaxis', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Scan with any UPI app.')).toBeVisible();
    await expect(button(guest.page, 'Open a UPI app on this phone')).toBeVisible();
    await expect(guest.page.getByText('Pay ₹300, then tap I’ve paid.')).toBeVisible();
    await expect(button(guest.page, 'Pay with Lightning instead')).toBeVisible();
    await button(guest.page, 'I’ve paid').click();
    await expect(guest.page.getByText('Waiting for Yash')).toBeVisible();
    await expect(guest.page.getByText('Paid by UPI. Yash will confirm it arrived.')).toBeVisible();
    await expect(button(guest.page, 'Pay by UPI')).toBeHidden();

    // With a UPI payment said to be made, asking for an invoice mints nothing.
    const opened = await api.raw<{ settlement?: unknown; upiClaim?: string }>(
      'POST',
      `/s/${link.token}/open`,
      { rail: 'lightning' },
      { token: null, key: `e2e-${link.token}` }
    );
    expect(opened.status).toBe(200);
    expect(opened.body.upiClaim).toBe('pending');
    expect(opened.body.settlement).toBeUndefined();

    await openGroup(yash.page, 'Goa trip', { reload: true });
    await groupTab(yash.page, 'Settle up');
    await expect(
      yash.page.getByText('Someone on a shared link says Om paid you ₹300 by UPI. Did it arrive? Check your UPI app.')
    ).toBeVisible();
    await button(yash.page, 'Yes, I got it').click();
    await expect(yash.page.getByText('All settled.', { exact: true })).toBeVisible();

    await expect(guest.page.getByText('Settled', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(guest.page.getByText('This has been settled. Nothing else to do — you can close this.')).toBeVisible();
    const settlements = await yash.api.settlements(group.id);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ rail: 'upi', status: 'manually_confirmed', note: 'Paid by UPI' });
  });

  test('turned down, the page says so and offers both ways again; Lightning instead goes to the invoice', async ({
    person,
    device,
  }) => {
    test.slow();
    const yash = await person('Yash');
    const { group } = await groupWhereGhostOwesMe(yash.api, { name: 'Goa trip', me: 'Yash', debtor: 'Om' });
    await yash.api.setUpiId('yash@okaxis');
    const link = await yash.api.payLinkFor(group.id, 'Om', 'Yash');

    const guest = await device();
    await openPayPage(guest.page, link.token);
    await button(guest.page, 'Pay by UPI').click();
    await button(guest.page, 'I’ve paid').click();
    await expect(guest.page.getByText('Waiting for Yash')).toBeVisible();

    await openGroup(yash.page, 'Goa trip', { reload: true });
    await groupTab(yash.page, 'Settle up');
    await button(yash.page, 'It didn’t arrive').click();
    await expect(yash.page.getByText('You said Om’s UPI payment of ₹300 didn’t arrive.')).toBeVisible();

    await expect(guest.page.getByText('The UPI payment didn’t arrive')).toBeVisible({ timeout: 20_000 });
    await expect(guest.page.getByText('Yash says it didn’t reach them. Check with them before paying again.')).toBeVisible();
    await expect(button(guest.page, 'Pay by UPI')).toBeVisible();
    await expect(button(guest.page, 'Pay with Lightning')).toBeVisible();

    // The other way, from the UPI panel: the invoice is minted now.
    await button(guest.page, 'Pay by UPI').click();
    await expect(guest.page.getByText('Yash’s UPI ID')).toBeVisible();
    await button(guest.page, 'Pay with Lightning instead').click();
    await expect(guest.page.getByText('Getting a fresh invoice…')).toBeVisible();
    await expect(button(guest.page, 'Open your wallet')).toBeVisible({ timeout: 15_000 });
    await expect(guest.page.getByText('Paid', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(yash.page.getByText('All settled.', { exact: true })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('A pay link in a group kept in bitcoin', () => {
  test('is owed in sats, with no rate anywhere', async ({ api, device }) => {
    test.slow();
    const yash = api.as((await api.account('Yash')).token);
    const { group } = await yash.seedGroup({
      name: 'Sats trip',
      people: ['Om'],
      currency: 'BTC',
      spends: [{ description: 'Beers', amount: 20_000, paidBy: 'Yash' }],
    });
    const link = await yash.payLinkFor(group.id, 'Om', 'Yash');
    const guest = await device();
    await openPayPage(guest.page, link.token);
    await expect(guest.page.getByText('Om, you owe Yash')).toBeVisible();
    await expect(button(guest.page, 'Open your wallet')).toBeVisible({ timeout: 15_000 });
    const release = await holdPolling(guest.page, link.token);
    await expect(guest.page.getByText('10,000 sats', { exact: true })).toBeVisible();
    await expect(guest.page.getByText(/^Invoice good for 1:[0-5]\d$/)).toBeVisible();
    await expect(guest.page.getByText('Exchange rate', { exact: true })).toBeHidden();
    await expect(guest.page.getByText('Rate from', { exact: true })).toBeHidden();
    await expect(guest.page.getByText('No real money moves', { exact: true })).toBeVisible();
    await expect(guest.page.getByText(/≈ \d+ sats, paid on top/)).toBeVisible();
    release();
    await expect(guest.page.getByText('Paid', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(guest.page.getByText('Amount', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('10,000 sats', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Payment proof', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Sent', { exact: true })).toBeHidden();
    await expect(guest.page.getByText('Exchange rate', { exact: true })).toBeHidden();
  });
});

void tokenOf;
