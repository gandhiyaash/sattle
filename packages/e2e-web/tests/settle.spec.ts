/**
 * Settling up inside the app: the Settle up tab, paying someone who has
 * joined over (simulated) Lightning, the blocked sheet and its remedies for
 * someone who hasn't, marking a debt settled from either side, what a payer
 * who uses only rupees is offered, simplifying debts, and a group kept in
 * bitcoin. Pay links have their own file: nothing here sends one, since the
 * group's link is what the person owed shares.
 *
 * Payments are simulated by the server (SIM_STEP_MS, SIM_SETTLE_MS in
 * src/env.ts), so every invoice confirms itself about three seconds after
 * it is made. A failed payment can't be had per test (SIM_ALWAYS_FAIL is a
 * server-wide switch), so that state isn't covered here.
 */

import {
  ancestor,
  button,
  clipboard,
  closeSheet,
  debtCard,
  groupTab,
  memberRow,
  openManage,
  screenText,
  section,
  waitForSettled,
} from '../src/actions';
import { expect, test } from '../src/fixtures';
import { countdownOf, duo, enter, intoGroup } from '../src/settle.helpers';

const PREIMAGE = /^[0-9a-f]{64}$/;

test.describe('the Settle up tab', () => {
  test('says all settled when nothing is owed, and swaps the footer button', async ({ api, device }) => {
    const { a, groupName } = await duo(api, device, {
      spends: [{ description: 'Cabs', amount: 60_000, paidBy: 'Yash', between: ['Yash'] }],
    });
    await intoGroup(a, groupName);
    await expect(button(a.page, 'Add expense')).toBeVisible();
    await expect(button(a.page, 'History')).toBeHidden();
    await groupTab(a.page, 'Settle up');
    await expect(a.page.getByText('All settled.', { exact: true })).toBeVisible();
    await expect(button(a.page, 'History')).toBeVisible();
    await expect(button(a.page, 'Add expense')).toBeHidden();
    await groupTab(a.page, 'Members');
    await expect(button(a.page, 'Add expense')).toBeVisible();
  });

  test('shows what each side owes, from both devices', async ({ api, device }) => {
    const { a, b, groupName } = await duo(api, device, {
      spends: [{ description: 'Villa', amount: 60_000, paidBy: 'Priya' }],
    });
    await intoGroup(a, groupName, 'Settle up');
    const owe = debtCard(a.page, 'You owe Priya');
    await expect(owe.getByText('₹300')).toBeVisible();
    await expect(button(owe, 'Pay')).toBeVisible();
    // Not theirs to mark: only the person owed can.
    await expect(button(owe, 'Mark as settled')).toBeHidden();
    await expect(a.page.getByText('You owe', { exact: true })).toBeVisible();

    await intoGroup(b, groupName, 'Settle up');
    const owed = debtCard(b.page, 'Yash owes you');
    await expect(owed.getByText('₹300')).toBeVisible();
    await expect(button(owed, 'Mark as settled')).toBeVisible();
    await expect(button(owed, 'Pay')).toBeHidden();
    await expect(b.page.getByText('You are owed', { exact: true })).toBeVisible();
  });
});

test.describe('paying someone who has joined, over Lightning', () => {
  test('opens straight on the invoice, settles, and both devices see it', async ({ api, device }) => {
    const { a, b, group, groupName } = await duo(api, device, {
      spends: [{ description: 'Villa', amount: 60_000, paidBy: 'Priya' }],
    });
    await intoGroup(b, groupName, 'Settle up');
    await expect(debtCard(b.page, 'Yash owes you')).toBeVisible();

    await intoGroup(a, groupName, 'Settle up');
    await button(debtCard(a.page, 'You owe Priya'), 'Pay').click();

    // The one way to pay starts on its own: no rails to choose from.
    await expect(a.page.getByText('Pay with Lightning', { exact: true })).toBeHidden();
    await expect(a.page.getByText('Waiting for payment').or(a.page.getByText('Pay Priya', { exact: true }))).toBeVisible();

    // The invoice is up for about two seconds, so read the screen once it shows.
    await expect(button(a.page, 'Open your wallet')).toBeVisible({ timeout: 8_000 });
    await button(a.page, 'Copy invoice').click();
    const text = await screenText(a.page);
    expect(text).toContain('Pay Priya');
    expect(text).toContain('₹300');
    expect(text).toContain('3,333 sats');
    expect(text).toContain('Exchange rate');
    expect(text).toContain('1 BTC = ₹90,00,000');
    expect(text).toContain('Rate from');
    expect(text).toContain('Demo rate. No real money moves');
    expect(text).toContain('Network fee');
    expect(text).toContain('≈ 10 sats, paid on top');
    expect(text).toContain('Or scan with any Lightning wallet.');
    expect(text).toContain('Waiting for the payment…');
    const left = countdownOf(text);
    expect(left, 'the countdown is on screen').not.toBeNull();
    expect(text).toMatch(/Rate and invoice locked for 1:[123]\d/);
    expect(await a.page.locator('svg').count()).toBeGreaterThan(0);
    expect(await clipboard(a.page)).toMatch(/^lnbc\d+n1sim/);

    await expect(a.page.getByText('Settled', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(a.page.getByText('₹300 to Priya is settled.')).toBeVisible();
    await expect(a.page.getByText('Payment proof')).toBeVisible();
    const proof = (await a.page.getByText(PREIMAGE).textContent())!;
    await button(a.page, 'Done').click();

    await expect(a.page.getByText('All settled.', { exact: true })).toBeVisible();
    await expect(a.page.getByText('All settled', { exact: true })).toBeVisible();
    // The payee's screen keeps itself current, every four seconds.
    await expect(b.page.getByText('All settled.', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(b.page.getByText('All settled', { exact: true })).toBeVisible();

    const settlements = await a.api.settlements(group.id);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ status: 'confirmed', rail: 'invoice', amount: 60_000 / 2, preimage: proof });

    // The groups list's headline follows.
    await a.page.getByText('‹', { exact: true }).first().click();
    await expect(a.page.getByText('All settled', { exact: true })).toBeVisible();
    await expect(a.page.getByText('settled', { exact: true }).first()).toBeVisible();
  });

  test('history records the payment with its proof', async ({ api, device }) => {
    const { a, groupName } = await duo(api, device, {
      spends: [{ description: 'Villa', amount: 60_000, paidBy: 'Priya' }],
    });
    await intoGroup(a, groupName, 'Settle up');
    await button(debtCard(a.page, 'You owe Priya'), 'Pay').click();
    await waitForSettled(a.page);

    await button(a.page, 'History').click();
    await expect(a.page.getByText('History', { exact: true })).toBeVisible();
    const row = a.page.getByText('Yash paid Priya', { exact: true });
    await expect(row).toBeVisible();
    await expect(a.page.getByText(/^Paid over Lightning · Today, /)).toBeVisible();
    await expect(a.page.getByText('₹300')).toBeVisible();
    await row.click();

    await expect(a.page.getByText('Paid', { exact: true })).toBeVisible();
    await expect(a.page.getByText('How', { exact: true })).toBeVisible();
    await expect(a.page.getByText('Lightning', { exact: true })).toBeVisible();
    await expect(a.page.getByText('Sent', { exact: true })).toBeVisible();
    await expect(a.page.getByText('3,333 sats')).toBeVisible();
    await expect(a.page.getByText('Exchange rate')).toBeVisible();
    await expect(a.page.getByText('1 BTC = ₹90,00,000')).toBeVisible();
    await expect(a.page.getByText('Marked by')).toBeHidden();
    await expect(a.page.getByText('Payment proof')).toBeVisible();
    const proof = (await a.page.getByText(PREIMAGE).textContent())!;
    await expect(a.page.getByText('Payments here are simulated, so this one is made up. A real one comes from the payer’s wallet.')).toBeVisible();
    await button(a.page, 'Copy proof').click();
    await expect(a.page.getByText('Copied.', { exact: true })).toBeVisible();
    expect(await clipboard(a.page)).toBe(proof);
    await button(a.page, 'Close').click();
    await expect(a.page.getByText('Copy proof')).toBeHidden();
  });

  test('closing the sheet and tapping Pay again picks the same invoice up', async ({ api, device }) => {
    const { a, group, groupName } = await duo(api, device, {
      spends: [{ description: 'Villa', amount: 60_000, paidBy: 'Priya' }],
    });
    await intoGroup(a, groupName, 'Settle up');
    const pay = button(debtCard(a.page, 'You owe Priya'), 'Pay');
    await pay.click();
    await expect(a.page.getByText('Waiting for payment').or(a.page.getByText('Pay Priya', { exact: true }))).toBeVisible();
    await closeSheet(a.page);
    await expect(a.page.getByText('Waiting for payment')).toBeHidden();
    await pay.click();
    await expect(a.page.getByText('A payment for this is already in progress.')).toBeHidden();
    await expect(a.page.getByText('Settled', { exact: true })).toBeVisible({ timeout: 15_000 });
    const proof = (await a.page.getByText(PREIMAGE).textContent())!;
    await button(a.page, 'Done').click();

    const settlements = await a.api.settlements(group.id);
    expect(settlements, 'one invoice, not two').toHaveLength(1);
    expect(settlements[0].preimage).toBe(proof);
  });

  test('a second device of the payer picks the same invoice up too', async ({ api, device }) => {
    const { a, group, groupName } = await duo(api, device, {
      spends: [{ description: 'Villa', amount: 60_000, paidBy: 'Priya' }],
    });
    const { page: other } = await device({ token: a.token });
    const twin = { ...a, page: other };
    await intoGroup(twin, groupName, 'Settle up');
    await expect(button(debtCard(other, 'You owe Priya'), 'Pay')).toBeVisible();

    await intoGroup(a, groupName, 'Settle up');
    await button(debtCard(a.page, 'You owe Priya'), 'Pay').click();
    await expect(a.page.getByText('Waiting for payment').or(a.page.getByText('Pay Priya', { exact: true }))).toBeVisible();
    await button(debtCard(other, 'You owe Priya'), 'Pay').click();

    await expect(a.page.getByText('Settled', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(other.getByText('Settled', { exact: true })).toBeVisible({ timeout: 15_000 });
    const [one, two] = await Promise.all([a.page.getByText(PREIMAGE).textContent(), other.getByText(PREIMAGE).textContent()]);
    expect(one).toBe(two);
    expect(await a.api.settlements(group.id)).toHaveLength(1);
  });

  test('the payee can’t mark it settled while the payer’s invoice is live', async ({ api, device }) => {
    const { a, b, group, groupName } = await duo(api, device, {
      spends: [{ description: 'Villa', amount: 60_000, paidBy: 'Priya' }],
    });
    await intoGroup(b, groupName, 'Settle up');
    const owed = debtCard(b.page, 'Yash owes you');
    await expect(button(owed, 'Mark as settled')).toBeVisible();

    await intoGroup(a, groupName, 'Settle up');
    await button(debtCard(a.page, 'You owe Priya'), 'Pay').click();
    await expect(a.page.getByText('Waiting for payment').or(a.page.getByText('Pay Priya', { exact: true }))).toBeVisible();

    await button(owed, 'Mark as settled').click();
    await expect(
      owed.getByText('A Lightning payment for this is under way. Wait for it to finish or its invoice to expire, then try again.')
    ).toBeVisible();

    await expect(a.page.getByText('Settled', { exact: true })).toBeVisible({ timeout: 15_000 });
    const settlements = await a.api.settlements(group.id);
    expect(settlements.map((s) => s.rail)).toEqual(['invoice']);
  });
});

test.describe('someone who hasn’t joined: the blocked sheet', () => {
  const seed = { spends: [{ description: 'Villa', amount: 50_000, paidBy: 'Aman', between: ['Yash', 'Aman'] }] };

  test('offers Options, not Pay, and says why', async ({ api, device }) => {
    const yash = await enter(api, device, 'Yash');
    await yash.api.seedGroup({ name: 'Goa trip', people: ['Aman'], ...seed });
    await intoGroup(yash, 'Goa trip', 'Settle up');
    const card = debtCard(yash.page, 'You owe Aman');
    await expect(card.getByText('₹250')).toBeVisible();
    await expect(button(card, 'Options')).toBeVisible();
    await expect(button(card, 'Pay')).toBeHidden();
    await expect(card.getByText('Aman hasn’t joined yet.')).toBeVisible();

    await button(card, 'Options').click();
    await expect(yash.page.getByText('You owe Aman ₹250')).toBeVisible();
    await expect(
      yash.page.getByText(
        "Aman hasn't set up a way to get paid yet. Add their Lightning address, invite them, or mark it settled if you paid another way."
      )
    ).toBeVisible();
    await expect(button(yash.page, 'Add their Lightning address')).toBeVisible();
    await expect(button(yash.page, 'Invite Aman')).toBeVisible();
    await expect(button(yash.page, 'Mark as settled')).toBeVisible();
    await expect(yash.page.getByText('Paid in cash, or forgiven.')).toBeVisible();
    await expect(button(yash.page, 'Close')).toBeVisible();
    await button(yash.page, 'Close').click();
    await expect(yash.page.getByText('You owe Aman ₹250')).toBeHidden();
  });

  test('takes a Lightning address for them, refusing what isn’t one', async ({ api, device }) => {
    const yash = await enter(api, device, 'Yash');
    const { group } = await yash.api.seedGroup({ name: 'Goa trip', people: ['Aman'], ...seed });
    await intoGroup(yash, 'Goa trip', 'Settle up');
    await button(debtCard(yash.page, 'You owe Aman'), 'Options').click();
    await button(yash.page, 'Add their Lightning address').click();
    await expect(yash.page.getByText('Where should this go?')).toBeVisible();
    await expect(yash.page.getByText('Ask Aman for their Lightning address.')).toBeVisible();

    // Back goes to the blocked screen, not to nothing.
    await button(yash.page, 'Back').click();
    await expect(yash.page.getByText('You owe Aman ₹250')).toBeVisible();
    await button(yash.page, 'Add their Lightning address').click();

    const field = yash.page.getByPlaceholder('aman@walletofsatoshi.com');
    await field.fill('lnbc10n1pjexamplefakeinvoice');
    await button(yash.page, 'Save address').click();
    await expect(
      yash.page.getByText("That's an invoice, which only works once. Ask for their Lightning address instead — it looks like an email.")
    ).toBeVisible();
    await field.fill('lnurl1dp68gurn8ghj7');
    await button(yash.page, 'Save address').click();
    await expect(yash.page.getByText('LNURL codes aren’t supported yet. Ask for the address that looks like an email.')).toBeVisible();
    await field.fill('nope');
    await button(yash.page, 'Save address').click();
    await expect(yash.page.getByText('That doesn’t look like a Lightning address. It should look like name@wallet.com.')).toBeVisible();
    await field.fill('');
    await button(yash.page, 'Save address').click();
    await expect(yash.page.getByText('Paste their Lightning address.')).toBeVisible();

    await field.fill('  Aman@WalletOfSatoshi.com ');
    await button(yash.page, 'Save address').click();
    // Back on the rails: the address can be paid from the phone's wallet only, and cash is still an option.
    await expect(yash.page.getByText('Pay Aman ₹250')).toBeVisible();
    const address = button(yash.page, 'Pay aman@walletofsatoshi.com');
    await expect(address).toBeVisible();
    await expect(ancestor(address, 2).getByText('Paying an address needs the mobile wallet.')).toBeVisible();
    await expect(ancestor(address, 1)).toHaveCSS('opacity', '0.4');
    const manual = button(yash.page, 'Mark as settled');
    await expect(ancestor(manual, 2).getByText('Paid in cash, UPI, or forgiven.')).toBeVisible();
    await expect(button(yash.page, 'Pay with Lightning')).toBeHidden();
    await address.click();
    await expect(yash.page.getByText('Pay Aman ₹250')).toBeVisible();

    const aman = (await yash.api.members(group.id)).find((m) => m.displayName === 'Aman')!;
    expect(aman).toMatchObject({ status: 'ghost', lightningAddress: 'aman@walletofsatoshi.com' });

    // Once it's saved the debt can be paid, so the card offers Pay.
    await closeSheet(yash.page);
    await expect(button(debtCard(yash.page, 'You owe Aman'), 'Pay')).toBeVisible({ timeout: 15_000 });
    await groupTab(yash.page, 'Members');
    await expect(memberRow(yash.page, 'Aman').getByText('aman@walletofsatoshi.com')).toBeVisible();
    await expect(memberRow(yash.page, 'Aman').getByText('Payable')).toBeVisible();
  });

  test('invites them with the group’s link', async ({ api, device }) => {
    const yash = await enter(api, device, 'Yash');
    const { group } = await yash.api.seedGroup({ name: 'Goa trip', people: ['Aman'], ...seed });
    await intoGroup(yash, 'Goa trip', 'Settle up');
    await button(debtCard(yash.page, 'You owe Aman'), 'Options').click();
    await button(yash.page, 'Invite Aman').click();
    await expect(yash.page.getByText('Copied. Paste it in a chat.')).toBeVisible();
    await expect(button(yash.page, 'Invite Aman again')).toBeVisible();
    const link = (await yash.api.groupLink(group.id))!;
    const url = `http://127.0.0.1:8900/g/${link.token}`;
    await expect(yash.page.getByText(url)).toBeVisible();
    expect(await clipboard(yash.page)).toBe(`Aman, join "Goa trip" on Sattle so I can pay you back. Open this and tap Join: ${url}`);
    // Inviting again hands out the same link rather than killing the one in the chat.
    await button(yash.page, 'Invite Aman again').click();
    await expect(yash.page.getByText(url)).toBeVisible();
    expect((await yash.api.groupLink(group.id))!.token).toBe(link.token);
  });

  test('the payer marks it settled, since there is nobody else to', async ({ api, device }) => {
    const yash = await enter(api, device, 'Yash');
    const { group } = await yash.api.seedGroup({ name: 'Goa trip', people: ['Aman'], ...seed });
    await intoGroup(yash, 'Goa trip', 'Settle up');
    await button(debtCard(yash.page, 'You owe Aman'), 'Options').click();
    await button(yash.page, 'Mark as settled').click();
    await expect(yash.page.getByText('Settled', { exact: true })).toBeVisible();
    await expect(yash.page.getByText('₹250 to Aman is settled.')).toBeVisible();
    await expect(yash.page.getByText('Payment proof')).toBeHidden();
    await button(yash.page, 'Done').click();
    await expect(yash.page.getByText('All settled.', { exact: true })).toBeVisible();

    await groupTab(yash.page, 'Members');
    const aman = memberRow(yash.page, 'Aman');
    await expect(aman.getByText('settled', { exact: true })).toBeVisible();
    await expect(aman.getByText('Not joined')).toBeVisible();
    await expect(aman.getByText('No app')).toBeVisible();

    const [settlement] = await yash.api.settlements(group.id);
    expect(settlement).toMatchObject({ rail: 'manual', status: 'manually_confirmed', amount: 25_000, note: 'Settled outside the app' });
    await groupTab(yash.page, 'Settle up');
    await button(yash.page, 'History').click();
    await expect(yash.page.getByText('Yash settled with Aman')).toBeVisible();
    await expect(yash.page.getByText(/^Marked as settled by Yash · /)).toBeVisible();
  });
});

test.describe('the payee’s side', () => {
  test('marks a debt settled in one tap, once, however many times it is tapped', async ({ api, device }) => {
    const { a, b, group, groupName } = await duo(api, device, {
      spends: [{ description: 'Villa', amount: 60_000, paidBy: 'Priya' }],
    });
    await intoGroup(a, groupName, 'Settle up');
    await expect(debtCard(a.page, 'You owe Priya')).toBeVisible();

    await intoGroup(b, groupName, 'Settle up');
    const owed = debtCard(b.page, 'Yash owes you');
    await button(owed, 'Mark as settled').dblclick();
    await expect(b.page.getByText('All settled.', { exact: true })).toBeVisible();
    await expect(a.page.getByText('All settled.', { exact: true })).toBeVisible({ timeout: 15_000 });

    const settlements = await a.api.settlements(group.id);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ rail: 'manual', status: 'manually_confirmed' });
    await button(b.page, 'History').click();
    await expect(b.page.getByText('Yash settled with Priya')).toBeVisible();
    await expect(b.page.getByText(/^Marked as settled by Priya · /)).toBeVisible();
    await b.page.getByText('Yash settled with Priya').click();
    await expect(b.page.getByText('Marked as settled', { exact: true })).toBeVisible();
    await expect(b.page.getByText('Marked by')).toBeVisible();
    await expect(b.page.getByText('Settled outside the app', { exact: true })).toBeVisible();
    await expect(b.page.getByText('No payment proof. This was settled outside the app, on Priya’s word.')).toBeVisible();
  });
});

test.describe('a payer who uses only rupees', () => {
  test('is pointed at UPI, and reminded that the payee has none', async ({ api, device }) => {
    const { a, groupName } = await duo(api, device, {
      a: { currencies: ['INR'] },
      spends: [{ description: 'Villa', amount: 60_000, paidBy: 'Priya' }],
    });
    await intoGroup(a, groupName, 'Members');
    await expect(memberRow(a.page, 'Priya').getByText('In app')).toBeVisible();
    await groupTab(a.page, 'Settle up');
    const card = debtCard(a.page, 'You owe Priya');
    await expect(button(card, 'Options')).toBeVisible();
    await expect(card.getByText('Priya hasn’t added a UPI ID yet.')).toBeVisible();
    await button(card, 'Options').click();
    await expect(
      a.page.getByText(
        "Priya hasn't added a UPI ID yet, so there's nowhere to pay them here. Ask them to add one from Wallet in Sattle. If you paid another way, ask them to mark it settled."
      )
    ).toBeVisible();
    await expect(button(a.page, 'Add their Lightning address')).toBeHidden();
    await expect(button(a.page, 'Mark as settled')).toBeHidden();
    await button(a.page, 'Remind Priya').click();
    await expect(a.page.getByText('Copied. Paste it in a chat.')).toBeVisible();
    await expect(button(a.page, 'Remind Priya again')).toBeVisible();
    expect(await clipboard(a.page)).toBe(
      'Priya, I want to pay you ₹300 for Goa trip on Sattle. Add your UPI ID in Sattle, under Wallet, so I can pay you.'
    );
  });

  test('is told a ghost isn’t on Sattle, and can invite them or settle by hand', async ({ api, device }) => {
    const yash = await enter(api, device, 'Yash', { currencies: ['INR'] });
    await yash.api.seedGroup({
      name: 'Goa trip',
      people: ['Aman'],
      spends: [{ description: 'Villa', amount: 50_000, paidBy: 'Aman' }],
    });
    await intoGroup(yash, 'Goa trip', 'Settle up');
    const card = debtCard(yash.page, 'You owe Aman');
    await expect(card.getByText('Aman hasn’t joined yet.')).toBeVisible();
    await button(card, 'Options').click();
    await expect(
      yash.page.getByText(
        "Aman isn't on Sattle yet, so there's nowhere to pay them. Invite them, and once they add a UPI ID you can pay here. Or mark it settled if you paid another way."
      )
    ).toBeVisible();
    await expect(button(yash.page, 'Invite Aman')).toBeVisible();
    await expect(button(yash.page, 'Mark as settled')).toBeVisible();
    await expect(button(yash.page, 'Add their Lightning address')).toBeHidden();
    await expect(button(yash.page, 'Remind Aman')).toBeHidden();
  });

  test('sees a payee with a UPI ID as taking UPI', async ({ api, device }) => {
    const { a, b, groupName } = await duo(api, device, {
      a: { currencies: ['INR'] },
      spends: [{ description: 'Villa', amount: 60_000, paidBy: 'Priya' }],
    });
    await b.api.setUpiId('priya@okaxis');
    await intoGroup(a, groupName, 'Members');
    await expect(memberRow(a.page, 'Priya').getByText('Takes UPI')).toBeVisible();
    await expect(memberRow(a.page, 'Yash (you)').getByText('In app')).toBeVisible();
    await groupTab(a.page, 'Settle up');
    await expect(button(debtCard(a.page, 'You owe Priya'), 'Pay')).toBeVisible();
  });
});

test.describe('simplifying debts', () => {
  // Yash paid ₹300 for the three of them, Priya ₹300 for her and Kabir. Nets: Yash +200, Priya +50, Kabir −250.
  const spends = [
    { description: 'Dinner', amount: 30_000, paidBy: 'Yash' },
    { description: 'Cab', amount: 30_000, paidBy: 'Priya', between: ['Priya', 'Kabir'] },
  ];

  test('combines debts into as few payments as there can be, until the group turns that off', async ({ api, device }) => {
    const yash = await enter(api, device, 'Yash');
    await yash.api.seedGroup({ name: 'Goa trip', people: ['Priya', 'Kabir'], spends });
    await intoGroup(yash, 'Goa trip', 'Settle up');
    // Simplified: Kabir pays Yash 200 and Priya 50. Yash sees only his.
    await expect(debtCard(yash.page, 'Kabir owes you').getByText('₹200')).toBeVisible();
    await expect(yash.page.getByText('Priya owes you')).toBeHidden();

    await openManage(yash.page);
    const switchOn = yash.page.getByRole('switch', { name: 'Simplify debts' });
    await expect(switchOn).toBeChecked();
    await expect(yash.page.getByText('Debts are combined, so everyone settles up in as few payments as possible.')).toBeVisible();
    await switchOn.click();
    await expect(yash.page.getByText('Everyone pays back the people who paid for them.')).toBeVisible();
    await expect(switchOn).not.toBeChecked();
    await yash.page.getByText('‹', { exact: true }).first().click();

    // Direct: everyone pays back whoever paid for them.
    await expect(debtCard(yash.page, 'Priya owes you').getByText('₹100')).toBeVisible();
    await expect(debtCard(yash.page, 'Kabir owes you').getByText('₹100')).toBeVisible();
    expect((await yash.api.groups())[0].simplifyDebts).toBe(false);
  });

  test('a group made without simplifying shows direct debts from the start', async ({ api, device }) => {
    const yash = await enter(api, device, 'Yash');
    await yash.api.seedGroup({ name: 'Goa trip', people: ['Priya', 'Kabir'], simplifyDebts: false, spends });
    await intoGroup(yash, 'Goa trip', 'Settle up');
    await expect(debtCard(yash.page, 'Priya owes you').getByText('₹100')).toBeVisible();
    await expect(debtCard(yash.page, 'Kabir owes you').getByText('₹100')).toBeVisible();
    await expect(yash.page.getByText('Kabir owes you').locator('../..').getByText('₹200')).toBeHidden();
  });
});

test.describe('a group kept in bitcoin', () => {
  test('is owed and paid in sats, with no exchange rate', async ({ api, device }) => {
    const { a, b, group, groupName } = await duo(api, device, {
      currency: 'BTC',
      spends: [{ description: 'Villa', amount: 10_000, paidBy: 'Priya' }],
    });
    await intoGroup(a, groupName, 'Settle up');
    const card = debtCard(a.page, 'You owe Priya');
    await expect(card.getByText('5,000 sats')).toBeVisible();
    await button(card, 'Pay').click();
    await expect(button(a.page, 'Open your wallet')).toBeVisible({ timeout: 8_000 });
    const text = await screenText(a.page);
    expect(text).toContain('Pay Priya');
    expect(text).toContain('5,000 sats');
    expect(text).toContain('Demo');
    expect(text).toContain('No real money moves');
    expect(text).toContain('≈ 15 sats, paid on top');
    expect(text).not.toContain('Exchange rate');
    expect(text).not.toContain('Rate from');
    expect(text).toMatch(/Invoice good for 1:[123]\d/);
    await expect(a.page.getByText('Settled', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(a.page.getByText('5,000 sats to Priya is settled.')).toBeVisible();
    await button(a.page, 'Done').click();
    await expect(a.page.getByText('All settled.', { exact: true })).toBeVisible();

    const [settlement] = await b.api.settlements(group.id);
    expect(settlement).toMatchObject({ currency: 'BTC', amount: 5_000, status: 'confirmed' });
    expect(settlement.quote).toMatchObject({ amountSat: 5_000, rateFiatPerBtc: 1, feeSat: 15 });

    await button(a.page, 'History').click();
    await a.page.getByText('Yash paid Priya').click();
    await expect(a.page.getByText('Sent', { exact: true })).toBeHidden();
    await expect(a.page.getByText('Exchange rate')).toBeHidden();
    await expect(a.page.getByText(PREIMAGE)).toBeVisible();
  });
});
