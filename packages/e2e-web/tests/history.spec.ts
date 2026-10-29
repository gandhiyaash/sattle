/**
 * History: what a group's history lists, in what order and words, and what
 * opening an entry shows, for an expense added, changed or removed and for a
 * debt settled by hand.
 */

import { button, groupTab } from '../src/actions';
import { expect, test, type Person } from '../src/fixtures';
import { breakdownRow, goToGroup, sheet } from '../src/groups.helpers';

import type { Page } from '@playwright/test';

/** From a group screen to its history: Settle up has the button. */
async function openHistory(page: Page) {
  await groupTab(page, 'Settle up');
  await button(page, 'History').click();
  await expect(page.getByText('History', { exact: true }).first()).toBeVisible();
}

/** "Oct 29, 2026, 11:50 AM" or "29 Oct 2026, 11:50": a whole date with a time. */
const DATE = /\d{4},? \d{1,2}:\d{2}/;

/**
 * A group with a story: Dinner and Cab added, Bob settling with Yash in cash,
 * Dinner changed into Supper (more, paid by Bob, Dee in and Carl out), and Cab
 * removed. In the history, newest first: Cab removed, Supper changed, the
 * settlement, Cab added, Dinner added.
 */
async function story(yash: Person) {
  const { group, idOf, expenses } = await yash.api.seedGroup({
    name: 'Trip',
    people: ['Bob', 'Carl', 'Dee'],
    spends: [
      { description: 'Dinner', amount: 30_000, paidBy: 'Yash', between: ['Yash', 'Bob', 'Carl'] },
      { description: 'Cab', amount: 6_000, paidBy: 'Yash' },
    ],
  });
  const [dinner, cab] = expenses;
  // Bob owes Yash ₹100 for the dinner and ₹15 for the cab.
  await yash.api.markSettled({
    groupId: group.id,
    fromMemberId: idOf('Bob'),
    toMemberId: idOf('Yash'),
    amount: 11_500,
    note: 'Settled outside the app',
  });
  await yash.api.put(`/groups/${group.id}/expenses/${dinner.id}`, {
    description: 'Supper',
    amount: 45_000,
    paidByMemberId: idOf('Bob'),
    splitMode: 'exact',
    parts: [
      { memberId: idOf('Yash'), amount: 15_000 },
      { memberId: idOf('Bob'), amount: 20_000 },
      { memberId: idOf('Dee'), amount: 10_000 },
    ],
  });
  await yash.api.del(`/groups/${group.id}/expenses/${cab.id}`);
  return group;
}

test.describe('The list', () => {
  test('starts empty', async ({ person }) => {
    const yash = await person('Yash');
    await yash.api.seedGroup({ name: 'Trip', people: ['Bob'] });
    await goToGroup(yash.page, 'Trip');
    await openHistory(yash.page);
    await expect(yash.page.getByText('Trip', { exact: true })).toBeVisible();
    await expect(
      yash.page.getByText('Nothing yet. What gets added, changed and paid in this group shows up here.')
    ).toBeVisible();
  });

  test('tells the story newest first, each line saying what happened, who did it and when', async ({ person }) => {
    const yash = await person('Yash');
    await story(yash);
    await goToGroup(yash.page, 'Trip');
    await openHistory(yash.page);
    const rows = yash.page.getByRole('button').filter({ hasText: /Today, / });
    await expect(rows).toHaveCount(5);
    const texts = await rows.allTextContents();
    expect(texts.map((t) => t.split(/Added|Changed|Removed|Marked/)[0])).toEqual(['Cab', 'Supper', 'Bob settled with Yash', 'Cab', 'Dinner']);
    await expect(rows.nth(0).getByText(/^Removed by Yash · Today, \d{1,2}:\d{2}/)).toBeVisible();
    await expect(rows.nth(1).getByText(/^Changed by Yash · Today, \d{1,2}:\d{2}/)).toBeVisible();
    await expect(rows.nth(2).getByText(/^Marked as settled by Yash · Today, \d{1,2}:\d{2}/)).toBeVisible();
    await expect(rows.nth(3).getByText(/^Added by Yash · Today, \d{1,2}:\d{2}/)).toBeVisible();
    await expect(rows.nth(4).getByText(/^Added by Yash · Today, \d{1,2}:\d{2}/)).toBeVisible();
    // Amounts: the removed one struck through, the rest as they are.
    await expect(rows.nth(0).getByText('₹60')).toHaveCSS('text-decoration-line', 'line-through');
    await expect(rows.nth(1).getByText('₹450')).toBeVisible();
    await expect(rows.nth(1).getByText('₹450')).not.toHaveCSS('text-decoration-line', 'line-through');
    await expect(rows.nth(2).getByText('₹115')).toBeVisible();
    await expect(rows.nth(3).getByText('₹60')).toBeVisible();
    await expect(rows.nth(4).getByText('₹300')).toBeVisible();
  });

  test('is reached from Settle up and Back returns there', async ({ person }) => {
    const yash = await person('Yash');
    await yash.api.seedGroup({ name: 'Trip', people: ['Bob'] });
    await goToGroup(yash.page, 'Trip');
    await expect(button(yash.page, 'History')).toHaveCount(0);
    await expect(button(yash.page, 'Add expense')).toBeVisible();
    await groupTab(yash.page, 'Settle up');
    await expect(button(yash.page, 'Add expense')).toHaveCount(0);
    await button(yash.page, 'History').click();
    await expect(yash.page.getByText('Nothing yet. What gets added, changed and paid in this group shows up here.')).toBeVisible();
    await button(yash.page, '‹').click();
    await expect(yash.page.getByRole('radio', { name: 'Settle up' })).toHaveAttribute('aria-checked', 'true');
    await expect(button(yash.page, 'History')).toBeVisible();
  });
});

test.describe('An entry in full', () => {
  test('an expense added: who paid, how it was split, and each person’s part', async ({ person }) => {
    const yash = await person('Yash');
    await story(yash);
    await goToGroup(yash.page, 'Trip');
    await openHistory(yash.page);
    await yash.page.getByRole('button', { name: /^Dinner/ }).click();
    const s = sheet(yash.page);
    await expect(s.getByText('Dinner', { exact: true })).toBeVisible();
    await expect(s.getByText('₹300', { exact: true })).toBeVisible();
    await expect(breakdownRow(s, 'Added').getByText(DATE)).toBeVisible();
    await expect(breakdownRow(s, 'Added by').getByText('Yash')).toBeVisible();
    await expect(breakdownRow(s, 'Paid by').getByText('Yash')).toBeVisible();
    await expect(breakdownRow(s, 'Split').getByText('Split equally, 3 ways')).toBeVisible();
    await expect(s.getByText('Each person’s part')).toBeVisible();
    for (const name of ['Yash', 'Bob', 'Carl']) await expect(breakdownRow(s, name).getByText('₹100')).toBeVisible();
    await expect(s.getByText('Dee', { exact: true })).toHaveCount(0);
    await button(s, 'Close').click();
    await expect(sheet(yash.page)).toHaveCount(0);
  });

  test('an expense changed: both sides of everything that moved', async ({ person }) => {
    const yash = await person('Yash');
    await story(yash);
    await goToGroup(yash.page, 'Trip');
    await openHistory(yash.page);
    await yash.page.getByRole('button', { name: /^Supper/ }).click();
    const s = sheet(yash.page);
    await expect(s.getByText('₹450', { exact: true })).toBeVisible();
    await expect(breakdownRow(s, 'Changed').getByText(DATE)).toBeVisible();
    await expect(breakdownRow(s, 'Changed by').getByText('Yash')).toBeVisible();
    await expect(breakdownRow(s, 'Name').getByText('Dinner → Supper')).toBeVisible();
    await expect(breakdownRow(s, 'Amount').getByText('₹300 → ₹450')).toBeVisible();
    await expect(breakdownRow(s, 'Paid by').getByText('Yash → Bob')).toBeVisible();
    await expect(breakdownRow(s, 'Split').getByText('Split equally, 3 ways → Exact amounts, 3 ways')).toBeVisible();
    await expect(breakdownRow(s, 'Yash').getByText('₹100 → ₹150')).toBeVisible();
    await expect(breakdownRow(s, 'Bob').getByText('₹100 → ₹200')).toBeVisible();
    await expect(breakdownRow(s, 'Dee').getByText('₹100, added')).toBeVisible();
    await expect(breakdownRow(s, 'Carl').getByText('₹100, taken out')).toBeVisible();
  });

  test('an expense removed: struck through, with how it read', async ({ person }) => {
    const yash = await person('Yash');
    await story(yash);
    await goToGroup(yash.page, 'Trip');
    await openHistory(yash.page);
    await yash.page.getByRole('button', { name: /^Cab/ }).first().click();
    const s = sheet(yash.page);
    await expect(s.getByText('Cab', { exact: true })).toBeVisible();
    await expect(s.getByText('₹60', { exact: true })).toHaveCSS('text-decoration-line', 'line-through');
    await expect(breakdownRow(s, 'Removed').getByText(DATE)).toBeVisible();
    await expect(breakdownRow(s, 'Removed by').getByText('Yash')).toBeVisible();
    await expect(breakdownRow(s, 'Paid by').getByText('Yash')).toBeVisible();
    await expect(breakdownRow(s, 'Split').getByText('Split equally, 4 ways')).toBeVisible();
    for (const name of ['Yash', 'Bob', 'Carl', 'Dee']) await expect(breakdownRow(s, name).getByText('₹15')).toBeVisible();
  });

  test('a debt settled by hand: whose word it was, and that there is no proof', async ({ person }) => {
    const yash = await person('Yash');
    await story(yash);
    await goToGroup(yash.page, 'Trip');
    await openHistory(yash.page);
    await yash.page.getByRole('button', { name: /^Bob settled with Yash/ }).click();
    const s = sheet(yash.page);
    await expect(s.getByText('Bob settled with Yash')).toBeVisible();
    await expect(s.getByText('₹115', { exact: true })).toBeVisible();
    await expect(breakdownRow(s, 'Marked as settled').getByText(DATE)).toBeVisible();
    await expect(breakdownRow(s, 'Marked by').getByText('Yash')).toBeVisible();
    await expect(breakdownRow(s, 'How').getByText('Settled outside the app')).toBeVisible();
    await expect(s.getByText('No payment proof. This was settled outside the app, on Yash’s word.')).toBeVisible();
    await expect(s.getByText('Payment proof', { exact: true })).toHaveCount(0);
    await button(s, 'Close').click();
    await expect(sheet(yash.page)).toHaveCount(0);
  });

  test('a settlement recorded by the payer, for a ghost, names the payer', async ({ person }) => {
    const yash = await person('Yash');
    const { group, idOf } = await yash.api.seedGroup({
      name: 'Trip',
      people: ['Priya'],
      spends: [{ description: 'Power', amount: 20_000, paidBy: 'Priya' }],
    });
    await yash.api.markSettled({ groupId: group.id, fromMemberId: idOf('Yash'), toMemberId: idOf('Priya'), amount: 10_000 });
    await goToGroup(yash.page, 'Trip');
    await openHistory(yash.page);
    const row = yash.page.getByRole('button', { name: /^Yash settled with Priya/ });
    await expect(row.getByText(/^Marked as settled by Yash · Today/)).toBeVisible();
    await row.click();
    const s = sheet(yash.page);
    await expect(breakdownRow(s, 'Marked by').getByText('Yash')).toBeVisible();
    await expect(breakdownRow(s, 'How').getByText('Settled outside the app')).toBeVisible();
    await expect(s.getByText('No payment proof. This was settled outside the app, on Yash’s word.')).toBeVisible();
  });
});
