/**
 * Paying by UPI from inside the app: the rails the sheet offers once the
 * person owed has a UPI ID, the UPI panel (QR code, the ID, a way to open an
 * app), "I’ve paid" and the question that follows it, what settling on the
 * payer's word leaves in the history, coming back from a UPI app, and what a
 * payer who uses only rupees is shown.
 *
 * A browser hears nothing back from a UPI app, so everything here is the
 * payer's word; the Android launcher isn't part of a web build.
 */

import { ancestor, button, clipboard, debtCard, groupTab, memberRow, saveUpiId, waitForSettled } from '../src/actions';
import { expect, test } from '../src/fixtures';
import { duo, intoGroup, type Who } from '../src/settle.helpers';

const ACCENT = 'rgb(194, 98, 28)';
const spends = [{ description: 'Villa', amount: 60_000, paidBy: 'Priya' }];

/** Yash owes Priya ₹300, and Priya can be paid by UPI. */
async function owingByUpi(api: Parameters<typeof duo>[0], device: Parameters<typeof duo>[1], a?: { currencies: ['INR'] }) {
  const made = await duo(api, device, { spends, a });
  await made.b.api.setUpiId('priya@okaxis');
  return made;
}

/** From the Settle up tab, through Pay by UPI to the panel. */
async function openUpi(a: Who) {
  await button(debtCard(a.page, 'You owe Priya'), 'Pay').click();
  await button(a.page, 'Pay by UPI').click();
  await expect(a.page.getByText('Pay Priya by UPI')).toBeVisible();
}

test.describe('the rails, once the payee has a UPI ID', () => {
  test('the payee adds the ID in Wallet, and the payer is offered both ways', async ({ api, device }) => {
    const { a, b, groupName } = await duo(api, device, { spends });
    await b.page.goto('/');
    await saveUpiId(b.page, 'priya@okaxis');
    await expect(b.page.getByText('priya@okaxis')).toBeVisible();

    await intoGroup(a, groupName, 'Settle up');
    const card = debtCard(a.page, 'You owe Priya');
    await expect(button(card, 'Pay')).toBeVisible();
    await button(card, 'Pay').click();
    await expect(a.page.getByText('Pay Priya ₹300')).toBeVisible();

    const lightning = button(a.page, 'Pay with Lightning');
    await expect(lightning).toBeVisible();
    await expect(ancestor(lightning, 1)).toHaveCSS('background-color', ACCENT);
    await expect(ancestor(lightning, 2).getByText('Any Lightning wallet')).toBeVisible();
    const upi = button(a.page, 'Pay by UPI');
    await expect(ancestor(upi, 2).getByText('GPay, PhonePe or any UPI app')).toBeVisible();
    await expect(ancestor(upi, 1)).not.toHaveCSS('background-color', ACCENT);
    const balance = button(a.page, 'Pay from your balance');
    await expect(ancestor(balance, 2).getByText('The wallet needs the mobile app.')).toBeVisible();
    await expect(ancestor(balance, 1)).toHaveCSS('opacity', '0.4');
    const manual = button(a.page, 'Mark as settled');
    await expect(ancestor(manual, 2).getByText('Only Priya can confirm a payment made outside the app.')).toBeVisible();
    await expect(ancestor(manual, 1)).toHaveCSS('opacity', '0.4');
    // Tapping a greyed-out rail does nothing.
    await manual.click();
    await expect(a.page.getByText('Pay Priya ₹300')).toBeVisible();
    await expect(a.page.getByText('Settled', { exact: true })).toBeHidden();
  });

  test('only someone who owes them is given the UPI ID', async ({ api, device }) => {
    const { a, b, group, members } = await owingByUpi(api, device);
    const priya = members.find((m) => m.displayName === 'Priya')!;
    const yash = members.find((m) => m.displayName === 'Yash')!;
    const asPayer = await a.api.raw('GET', `/groups/${group.id}/members/${priya.id}/upi`);
    expect(asPayer.status).toBe(200);
    expect(asPayer.body).toEqual({ upiId: 'priya@okaxis', name: 'Priya' });
    // Priya owes Yash nothing, and Yash has no UPI ID anyway.
    const asPayee = await b.api.raw<{ code: string; message: string }>('GET', `/groups/${group.id}/members/${yash.id}/upi`);
    expect(asPayee.status).toBe(409);
    expect(asPayee.body.message).toBe('You don’t owe Yash anything right now.');
    // Nobody is given it from the member list.
    const listed = (await a.api.members(group.id)).find((m) => m.displayName === 'Priya')!;
    expect(listed.upi).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('okaxis');
  });
});

test.describe('the UPI panel', () => {
  test('shows who to pay, a QR code, the ID to copy, and a way to open an app', async ({ api, device }) => {
    const { a, groupName } = await owingByUpi(api, device);
    await intoGroup(a, groupName, 'Settle up');
    await openUpi(a);

    const modal = a.page.locator('[aria-modal="true"]');
    await expect(modal.getByText('₹300', { exact: true })).toBeVisible();
    await expect(modal.getByText('Pay in any UPI app, then tap I’ve paid.')).toBeVisible();
    expect(await modal.locator('svg').count()).toBeGreaterThan(0);
    await expect(modal.getByText('Scan with any UPI app.')).toBeVisible();
    await expect(modal.getByText('Priya’s UPI ID')).toBeVisible();
    await expect(modal.getByText('priya@okaxis')).toBeVisible();
    await modal.getByRole('button', { name: 'Copy UPI ID' }).click();
    await expect(modal.getByText('Copied.', { exact: true })).toBeVisible();
    expect(await clipboard(a.page)).toBe('priya@okaxis');
    await expect(button(modal, 'Open a UPI app on this phone')).toBeVisible();
    const paid = button(modal, 'I’ve paid');
    await expect(ancestor(paid, 1)).toHaveCSS('background-color', ACCENT);

    await button(modal, 'Back').click();
    await expect(a.page.getByText('Pay Priya ₹300')).toBeVisible();
    await expect(button(a.page, 'Pay by UPI')).toBeVisible();
    await expect(a.page.getByText('Pay Priya by UPI')).toBeHidden();
  });

  test('the link in the QR code names the payee, the amount and the group', async ({ api, device }) => {
    const { a, groupName } = await owingByUpi(api, device);
    await intoGroup(a, groupName, 'Settle up');
    await openUpi(a);
    // The same text the QR code holds is what "Open a UPI app" navigates to. No app here can take
    // the link, so the browser drops the navigation; DevTools still sees it asked for.
    const cdp = await a.page.context().newCDPSession(a.page);
    await cdp.send('Page.enable');
    const asked: string[] = [];
    cdp.on('Page.frameRequestedNavigation', (e) => asked.push(e.url));
    await button(a.page, 'Open a UPI app on this phone').click();
    await expect.poll(() => asked.length, { timeout: 5_000 }).toBeGreaterThan(0);
    expect(asked[0]).toBe('upi://pay?pa=priya@okaxis&pn=Priya&am=300.00&cu=INR&tn=Sattle%20Goa%20trip');
    await cdp.detach();
    // The page stayed where it was.
    await expect(a.page.getByText('Pay Priya by UPI')).toBeVisible();
    await expect(a.page.getByText('priya@okaxis')).toBeVisible();
  });
});

test.describe('I’ve paid', () => {
  test('asks whether it went through, and refuses a reference that isn’t one', async ({ api, device }) => {
    const { a, groupName } = await owingByUpi(api, device);
    await intoGroup(a, groupName, 'Settle up');
    await openUpi(a);
    await button(a.page, 'I’ve paid').click();
    await expect(a.page.getByText('Did the payment go through?')).toBeVisible();
    await expect(a.page.getByText('₹300 to Priya', { exact: true })).toBeVisible();
    const field = a.page.getByPlaceholder('UPI reference, if you have it');
    await expect(field).toBeVisible();
    await expect(a.page.getByText('The 12-digit number your UPI app shows.')).toBeVisible();

    await field.fill('abc');
    await button(a.page, 'Yes, it went through').click();
    const refused = a.page.getByText(
      'That doesn’t look like a UPI reference. It’s the number your UPI app shows for the payment, usually 12 digits.'
    );
    await expect(refused).toBeVisible();
    // Typing again clears it.
    await field.fill('abc1');
    await expect(refused).toBeHidden();
    await field.fill('123');
    await button(a.page, 'Yes, it went through').click();
    await expect(refused).toBeVisible();
    await expect(a.page.getByText('Settled', { exact: true })).toBeHidden();

    await button(a.page, 'No, it didn’t go through').click();
    await expect(a.page.getByText('Pay Priya by UPI')).toBeVisible();
    await expect(a.page.getByText('Did the payment go through?')).toBeHidden();
    expect(await a.api.settlements((await a.api.groups())[0].id)).toHaveLength(0);
  });

  test('yes, with no reference, settles it on the payer’s word', async ({ api, device }) => {
    const { a, b, group, groupName, idOf } = await owingByUpi(api, device);
    await intoGroup(b, groupName, 'Settle up');
    await expect(debtCard(b.page, 'Yash owes you')).toBeVisible();

    await intoGroup(a, groupName, 'Settle up');
    await openUpi(a);
    await button(a.page, 'I’ve paid').click();
    await button(a.page, 'Yes, it went through').click();
    await expect(a.page.getByText('Settled', { exact: true })).toBeVisible();
    await expect(a.page.getByText('₹300 to Priya is settled. Priya has nothing to confirm.')).toBeVisible();
    await expect(a.page.getByText('UPI reference')).toBeHidden();
    await expect(a.page.getByText('Payment proof')).toBeHidden();
    await button(a.page, 'Done').click();
    await expect(a.page.getByText('All settled.', { exact: true })).toBeVisible();
    await expect(b.page.getByText('All settled.', { exact: true })).toBeVisible({ timeout: 15_000 });

    const [settlement] = await a.api.settlements(group.id);
    expect(settlement).toMatchObject({
      rail: 'upi',
      status: 'manually_confirmed',
      amount: 30_000,
      note: 'Paid by UPI',
      recordedByMemberId: idOf('Yash'),
      upi: { byPayer: true },
    });
    expect(settlement.upi).not.toHaveProperty('reference');

    await button(a.page, 'History').click();
    await expect(a.page.getByText('Yash paid Priya')).toBeVisible();
    await expect(a.page.getByText(/^Paid by UPI, as Yash said · Today, /)).toBeVisible();
    await a.page.getByText('Yash paid Priya').click();
    await expect(a.page.getByText('Paid', { exact: true })).toBeVisible();
    await expect(a.page.getByText('Reported by')).toBeVisible();
    await expect(ancestor(a.page.getByText('Reported by'), 1).getByText('Yash', { exact: true })).toBeVisible();
    await expect(ancestor(a.page.getByText('How', { exact: true }), 1).getByText('Paid by UPI', { exact: true })).toBeVisible();
    await expect(a.page.getByText('UPI reference')).toBeHidden();
    await expect(
      a.page.getByText('No payment proof. Yash said this went through, and Sattle can’t check that. They gave no reference to find it by.')
    ).toBeVisible();
  });

  test('yes, with the reference, keeps it for the statement', async ({ api, device }) => {
    const { a, group, groupName } = await owingByUpi(api, device);
    await intoGroup(a, groupName, 'Settle up');
    await openUpi(a);
    await button(a.page, 'I’ve paid').click();
    await a.page.getByPlaceholder('UPI reference, if you have it').fill(' 1234 5678-9012 ');
    await button(a.page, 'Yes, it went through').click();
    await expect(a.page.getByText('Settled', { exact: true })).toBeVisible();
    await expect(a.page.getByText('UPI reference')).toBeVisible();
    await expect(a.page.getByText('123456789012')).toBeVisible();
    await expect(a.page.getByText('Paid with')).toBeHidden();
    await button(a.page, 'Done').click();

    const [settlement] = await a.api.settlements(group.id);
    expect(settlement.upi).toEqual({ byPayer: true, reference: '123456789012' });

    await button(a.page, 'History').click();
    await a.page.getByText('Yash paid Priya').click();
    await expect(a.page.getByText('123456789012')).toBeVisible();
    await expect(
      a.page.getByText(
        'No payment proof. Yash said this went through and gave the reference above, and Sattle can’t check that. The reference is for finding it in a bank or UPI statement.'
      )
    ).toBeVisible();
  });

  test('a double tap on yes settles it once', async ({ api, device }) => {
    const { a, group, groupName } = await owingByUpi(api, device);
    await intoGroup(a, groupName, 'Settle up');
    await openUpi(a);
    await button(a.page, 'I’ve paid').click();
    await button(a.page, 'Yes, it went through').dblclick();
    await expect(a.page.getByText('Settled', { exact: true })).toBeVisible();
    await button(a.page, 'Done').click();
    await expect(a.page.getByText('All settled.', { exact: true })).toBeVisible();
    expect(await a.api.settlements(group.id)).toHaveLength(1);
  });

  test('coming back from the UPI app asks whether it went through', async ({ api, device }) => {
    const { a, group, groupName } = await owingByUpi(api, device);
    await intoGroup(a, groupName, 'Settle up');
    await openUpi(a);
    await button(a.page, 'Open a UPI app on this phone').click();
    await expect(a.page.getByText('Pay Priya by UPI')).toBeVisible();
    // The browser went behind the UPI app, then came back: what the page sees of that is its visibility.
    const seen = (state: 'hidden' | 'visible') =>
      a.page.evaluate((state) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
        document.dispatchEvent(new Event('visibilitychange'));
      }, state);
    await seen('hidden');
    await seen('visible');
    await expect(a.page.getByText('Did the payment go through?')).toBeVisible();
    await expect(a.page.getByPlaceholder('UPI reference, if you have it')).toBeVisible();

    // After the dropped hand-off to a upi: link plus a faked hide and show, headless Chromium no
    // longer delivers synthesized pointer input to this page (a real click on any button in the
    // sheet is ignored, a scripted click event isn't), so from here the taps are script-made.
    const tap = (label: string) => button(a.page, label).dispatchEvent('click');
    await tap('No, it didn’t go through');
    await expect(a.page.getByText('Pay Priya by UPI')).toBeVisible();
    // Hidden and shown again without having left for an app: nothing to ask.
    await seen('hidden');
    await seen('visible');
    await expect(a.page.getByText('Did the payment go through?')).toBeHidden();
    await expect(a.page.getByText('Pay Priya by UPI')).toBeVisible();

    // Leaving again asks again, and yes settles it.
    await tap('Open a UPI app on this phone');
    await seen('hidden');
    await seen('visible');
    await expect(a.page.getByText('Did the payment go through?')).toBeVisible();
    await tap('Yes, it went through');
    await expect(a.page.getByText('Settled', { exact: true })).toBeVisible();
    await expect(a.page.getByText('₹300 to Priya is settled. Priya has nothing to confirm.')).toBeVisible();
    const [settlement] = await a.api.settlements(group.id);
    expect(settlement.upi).toEqual({ byPayer: true });
  });
});

test.describe('a payer who uses only rupees', () => {
  test('is offered UPI alone', async ({ api, device }) => {
    const { a, groupName } = await owingByUpi(api, device, { currencies: ['INR'] });
    await intoGroup(a, groupName, 'Members');
    await expect(memberRow(a.page, 'Priya').getByText('Takes UPI')).toBeVisible();
    await groupTab(a.page, 'Settle up');
    await button(debtCard(a.page, 'You owe Priya'), 'Pay').click();
    await expect(a.page.getByText('Pay Priya ₹300')).toBeVisible();
    const upi = button(a.page, 'Pay by UPI');
    await expect(ancestor(upi, 1)).toHaveCSS('background-color', ACCENT);
    await expect(button(a.page, 'Pay with Lightning')).toBeHidden();
    await expect(button(a.page, 'Pay from your balance')).toBeHidden();
    await expect(ancestor(button(a.page, 'Mark as settled'), 2).getByText('Only Priya can confirm a payment made outside the app.')).toBeVisible();
    await upi.click();
    await expect(a.page.getByText('Pay Priya by UPI')).toBeVisible();
    await button(a.page, 'I’ve paid').click();
    await button(a.page, 'Yes, it went through').click();
    await waitForSettled(a.page);
    await expect(a.page.getByText('All settled.', { exact: true })).toBeVisible();
  });
});

test.describe('what the members list and the debt say, by who uses what', () => {
  const cases = [
    { payer: 'both currencies', payee: 'has a UPI ID', state: 'In app', action: 'Pay' },
    { payer: 'both currencies', payee: 'has no UPI ID', state: 'In app', action: 'Pay' },
    { payer: 'rupees only', payee: 'has a UPI ID', state: 'Takes UPI', action: 'Pay' },
    { payer: 'rupees only', payee: 'has no UPI ID', state: 'In app', action: 'Options' },
  ] as const;

  for (const c of cases) {
    test(`a payer using ${c.payer} sees a payee who ${c.payee} as "${c.state}", with ${c.action}`, async ({ api, device }) => {
      const { a, b, groupName } = await duo(api, device, {
        spends,
        a: c.payer === 'rupees only' ? { currencies: ['INR'] } : {},
      });
      if (c.payee === 'has a UPI ID') await b.api.setUpiId('priya@okaxis');
      await intoGroup(a, groupName, 'Members');
      await expect(memberRow(a.page, 'Priya').getByText(c.state, { exact: true })).toBeVisible();
      await expect(memberRow(a.page, 'Yash (you)').getByText('In app')).toBeVisible();
      await groupTab(a.page, 'Settle up');
      const card = debtCard(a.page, 'You owe Priya');
      await expect(button(card, c.action)).toBeVisible();
      await expect(button(card, c.action === 'Pay' ? 'Options' : 'Pay')).toBeHidden();
    });
  }
});
