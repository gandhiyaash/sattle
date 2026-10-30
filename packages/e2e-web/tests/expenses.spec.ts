/**
 * Expenses: the form and its live split preview, each way of splitting, what
 * the form refuses, how typed amounts are read, who may change an expense,
 * and that every balance in the app agrees with the maths.
 */

import {
  addExpense,
  back,
  button,
  createGroup,
  debtCard,
  expenseForm,
  goToGroup,
  groupHeader,
  groupTab,
  joinAs,
  memberRow,
  openGroup,
  saveExpense,
} from '../src/actions';
import { expect, test } from '../src/fixtures';

import type { Page } from '@playwright/test';

/** Add expense, from the group screen, with the form up. */
async function openForm(page: Page) {
  await button(page, 'Add expense').click();
  await expect(expenseForm.description(page)).toBeVisible();
}

/** The stepper buttons carry a label and no role, so they are found by the label. */
const moreShares = (page: Page, name: string) => page.getByLabel(`One more share for ${name}`);
const fewerShares = (page: Page, name: string) => page.getByLabel(`One fewer share for ${name}`);

test.describe('Split equally', () => {
  test('shows each person’s share as the amount is typed, remainder first', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Trip', people: ['Bob', 'Carl'] });
    await openForm(page);
    await expenseForm.amount(page).fill('100');
    await expect(page.getByText('₹33.34', { exact: true })).toHaveCount(1);
    await expect(page.getByText('₹33.33', { exact: true })).toHaveCount(2);
    await expect(page.getByText('Remainder is spread a paisa at a time, so the split always adds up.')).toBeVisible();
    await expenseForm.amount(page).fill('99');
    await expect(page.getByText('₹33', { exact: true })).toHaveCount(3);
    await expenseForm.between(page, 'Carl').click();
    await expect(page.getByText('₹49.50', { exact: true })).toHaveCount(2);
    await expenseForm.between(page, 'Bob').click();
    await expect(page.getByText('₹99', { exact: true })).toHaveCount(1);
    // One person left: nothing to spread.
    await expect(page.getByText('Remainder is spread a paisa at a time, so the split always adds up.')).toBeHidden();
    await expenseForm.description(page).fill('Mine');
    await saveExpense(page);
    await expect(page.getByText('Yash paid · all for Yash')).toBeVisible();
    await expect(page.getByText('3 members · 1 expense')).toBeVisible();
    // Paid for yourself alone: nobody owes anyone.
    await expect(page.getByText('All settled', { exact: true })).toBeVisible();
    await groupTab(page, 'Members');
    await expect(page.getByText('settled', { exact: true })).toHaveCount(4);
  });

  test('Enter on the name goes to the amount', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Trip' });
    await openForm(page);
    await expenseForm.description(page).fill('Villa');
    await expenseForm.description(page).press('Enter');
    await expect(expenseForm.amount(page)).toBeFocused();
  });
});

test.describe('Split by shares', () => {
  test('steppers change the shares within bounds and the amounts follow', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Trip', people: ['Bob', 'Carl'] });
    await openForm(page);
    await expenseForm.description(page).fill('Villa');
    await expenseForm.amount(page).fill('300');
    await expenseForm.split(page, 'By shares').click();
    await expect(page.getByText('Two shares pays twice what one share does. Use it for someone who had more.')).toBeVisible();
    await expect(page.getByText('₹100', { exact: true })).toHaveCount(3);
    await moreShares(page, 'Yash').click();
    await expect(page.getByText('2', { exact: true })).toBeVisible();
    await expect(page.getByText('₹150', { exact: true })).toHaveCount(1);
    await expect(page.getByText('₹75', { exact: true })).toHaveCount(2);
    // Fewer than one share is no share: the button is greyed out and does nothing. The label is on the button itself.
    await expect(fewerShares(page, 'Bob')).toHaveAttribute('aria-disabled', 'true');
    await fewerShares(page, 'Bob').click({ force: true });
    await expect(page.getByText('₹75', { exact: true })).toHaveCount(2);
    await expenseForm.between(page, 'Carl').click();
    await expect(page.getByText('₹200', { exact: true })).toHaveCount(1);
    await expect(page.getByText('₹100', { exact: true })).toHaveCount(1);
    // No more than 99 shares.
    for (let i = 2; i < 99; i++) await moreShares(page, 'Yash').click();
    await expect(page.getByText('99', { exact: true })).toBeVisible();
    await expect(moreShares(page, 'Yash')).toHaveAttribute('aria-disabled', 'true');
    await moreShares(page, 'Yash').click({ force: true });
    await expect(page.getByText('99', { exact: true })).toBeVisible();
    await expect(page.getByText('₹297', { exact: true })).toBeVisible();
    await expect(page.getByText('₹3', { exact: true })).toBeVisible();
    await fewerShares(page, 'Yash').click();
    await expect(page.getByText('98', { exact: true })).toBeVisible();
    await saveExpense(page);
    await expect(page.getByText('Yash paid · split by shares, 2 ways')).toBeVisible();
    await expect(page.getByText('₹300', { exact: true })).toBeVisible();
    // 300 × 98/99 = ₹297.0, Bob ₹3.03 → Yash owes himself nothing, Bob owes ₹3.03.
    await groupTab(page, 'Settle up');
    await expect(debtCard(page, 'Bob owes you').getByText('₹3.03')).toBeVisible();
  });
});

test.describe('Exact amounts', () => {
  test('keeps a running total and refuses a split that doesn’t add up', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Trip', people: ['Bob', 'Carl'] });
    await openForm(page);
    await expenseForm.description(page).fill('Dinner');
    await expenseForm.amount(page).fill('300');
    await expenseForm.split(page, 'Exact').click();
    await expect(page.getByText('₹300 left to assign')).toBeVisible();
    await expenseForm.exact(page, 'Yash').fill('100');
    await expect(page.getByText('₹200 left to assign')).toBeVisible();
    await expenseForm.exact(page, 'Bob').fill('100');
    await expect(page.getByText('₹100 left to assign')).toBeVisible();
    await expenseForm.exact(page, 'Carl').fill('150');
    await expect(page.getByText('₹50 over the total')).toBeVisible();
    await saveExpense(page);
    await expect(page.getByText('The amounts are ₹50 more than the total.')).toBeVisible();
    await expenseForm.exact(page, 'Carl').fill('');
    await saveExpense(page);
    await expect(page.getByText('₹100 still to assign.')).toBeVisible();
    await expenseForm.exact(page, 'Carl').fill('100');
    await expect(page.getByText('Adds up to the total.')).toBeVisible();
    await saveExpense(page);
    await expect(page.getByText('Yash paid · exact amounts, 3 ways')).toBeVisible();
    await groupTab(page, 'Members');
    await expect(memberRow(page, 'Yash (you)').getByText('₹200')).toBeVisible();
    await expect(memberRow(page, 'Bob').getByText('₹100')).toBeVisible();
    await expect(memberRow(page, 'Carl').getByText('₹100')).toBeVisible();
  });

  test('a person taken out of the split keeps no field', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Trip', people: ['Bob'] });
    await openForm(page);
    await expenseForm.split(page, 'Exact').click();
    await expect(expenseForm.exact(page, 'Bob')).toBeVisible();
    await expenseForm.between(page, 'Bob').click();
    await expect(expenseForm.exact(page, 'Bob')).toHaveCount(0);
    await expect(expenseForm.exact(page, 'Yash')).toBeVisible();
  });
});

test.describe('What the form refuses', () => {
  test('asks for a name, an amount and at least one person, in that order', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Trip', people: ['Bob'] });
    await openForm(page);
    await saveExpense(page);
    await expect(page.getByText('Give it a name.')).toBeVisible();
    await expenseForm.description(page).fill('   ');
    await saveExpense(page);
    await expect(page.getByText('Give it a name.')).toBeVisible();
    await expenseForm.description(page).fill('Villa');
    await saveExpense(page);
    await expect(page.getByText('Enter an amount.')).toBeVisible();
    await expenseForm.amount(page).fill('100');
    await expenseForm.between(page, 'Yash').click();
    await expenseForm.between(page, 'Bob').click();
    await saveExpense(page);
    await expect(page.getByText('Include at least one person.')).toBeVisible();
    await expect(groupHeader(page)).toHaveCount(0);
  });

  for (const [typed, shown] of [
    ['1,250.50', '₹1,250.50'],
    ['12.345', '₹12.35'],
    ['0.01', '₹0.01'],
    ['99999999', '₹9,99,99,999'],
    ['  42  ', '₹42'],
  ] as const) {
    test(`reads "${typed}" as ${shown}`, async ({ person }) => {
      const { page } = await person('Yash');
      await createGroup(page, { name: 'Trip' });
      await addExpense(page, { description: 'Thing', amount: typed });
      await expect(page.getByText(shown, { exact: true })).toBeVisible();
    });
  }

  for (const typed of ['0', 'abc', '.']) {
    test(`refuses "${typed}" as an amount`, async ({ person }) => {
      const { page } = await person('Yash');
      await createGroup(page, { name: 'Trip' });
      await openForm(page);
      await expenseForm.description(page).fill('Thing');
      await expenseForm.amount(page).fill(typed);
      await saveExpense(page);
      await expect(page.getByText('Enter an amount.')).toBeVisible();
    });
  }

  test('a minus sign is not an amount', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await createGroup(page, { name: 'Trip' });
    await openForm(page);
    await expenseForm.description(page).fill('Refund');
    await expenseForm.amount(page).fill('-50');
    await saveExpense(page);
    await expect(page.getByText('Enter an amount.')).toBeVisible();
    expect(await yash.api.expenses((await yash.api.groups())[0].id)).toHaveLength(0);
  });

  test('a name of 200 characters is kept and 201 is refused by the server', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Trip' });
    await addExpense(page, { description: 'x'.repeat(200), amount: '10' });
    await expect(page.getByText('x'.repeat(200), { exact: true })).toBeVisible();
    await openForm(page);
    await expenseForm.description(page).fill('y'.repeat(201));
    await expenseForm.amount(page).fill('10');
    await saveExpense(page);
    // The server's refusal, shown as it came.
    await expect(page.getByText(/^description: /)).toBeVisible();
    await expect(expenseForm.description(page)).toBeVisible();
  });
});

test.describe('Who paid', () => {
  test('on your own device you are the payer unless another is picked', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Trip', people: ['Bob'] });
    await addExpense(page, { description: 'Villa', amount: '100' });
    await expect(page.getByText('Yash paid · split equally, 2 ways')).toBeVisible();
    await addExpense(page, { description: 'Cab', amount: '50', paidBy: 'Bob' });
    await expect(page.getByText('Bob paid · split equally, 2 ways')).toBeVisible();
    await expect(page.getByText('2 members · 2 expenses')).toBeVisible();
    await expect(page.getByText('You are owed', { exact: true })).toBeVisible();
    await expect(page.getByText('₹25', { exact: true })).toBeVisible();
    await groupTab(page, 'Settle up');
    await expect(debtCard(page, 'Bob owes you').getByText('₹25')).toBeVisible();
  });

  test('whoever adds the expense is the payer unless they say otherwise, on any device', async ({ person }) => {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const { group } = await alice.api.seedGroup({ name: 'Trip', people: ['Bob'] });
    await joinAs(alice, group.id, bob, 'Bob');
    await goToGroup(bob.page, 'Trip');
    await addExpense(bob.page, { description: 'Cab', amount: '60' });
    await expect(bob.page.getByText('Bob paid · split equally, 2 ways')).toBeVisible();
  });
});

test.describe('Balances agree everywhere', () => {
  test('the group, the list, the members and the debts tell one story', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await yash.api.seedGroup({
      name: 'Trip',
      people: ['Bob', 'Carl'],
      spends: [
        { description: 'Villa', amount: 30_000, paidBy: 'Yash' },
        { description: 'Cab', amount: 9_000, paidBy: 'Carl', between: ['Yash', 'Carl'] },
      ],
    });
    // Yash: +300 −100 −45 = +155. Bob: −100. Carl: −100 +90 −45 = −55.
    await page.goto('/');
    await expect(page.getByText('You’re owed', { exact: true })).toBeVisible();
    await expect(page.getByText('₹155', { exact: true })).toHaveCount(3); // the headline, owed to you, and the row
    await expect(page.getByText('you’re owed', { exact: true })).toBeVisible();
    await openGroup(page, 'Trip');
    await expect(page.getByText('You are owed', { exact: true })).toBeVisible();
    await expect(page.getByText('₹155', { exact: true })).toBeVisible();
    await groupTab(page, 'Members');
    await expect(memberRow(page, 'Yash (you)').getByText('gets back')).toBeVisible();
    await expect(memberRow(page, 'Yash (you)').getByText('₹155')).toBeVisible();
    await expect(memberRow(page, 'Bob').getByText('owes')).toBeVisible();
    await expect(memberRow(page, 'Bob').getByText('₹100')).toBeVisible();
    await expect(memberRow(page, 'Carl').getByText('owes')).toBeVisible();
    await expect(memberRow(page, 'Carl').getByText('₹55')).toBeVisible();
    await groupTab(page, 'Settle up');
    await expect(debtCard(page, 'Bob owes you').getByText('₹100')).toBeVisible();
    await expect(debtCard(page, 'Carl owes you').getByText('₹55')).toBeVisible();
    await expect(page.getByText(/^You owe/)).toHaveCount(0);
  });
});

test.describe('Changing an expense', () => {
  test('opens prefilled and saves the change', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await yash.api.seedGroup({
      name: 'Trip',
      people: ['Bob'],
      spends: [{ description: 'Dinner', amount: 30_050, paidBy: 'Yash' }],
    });
    await goToGroup(page, 'Trip');
    await page.getByText('Dinner', { exact: true }).click();
    await expect(page.getByText('Edit expense', { exact: true })).toBeVisible();
    await expect(expenseForm.description(page)).toHaveValue('Dinner');
    await expect(expenseForm.amount(page)).toHaveValue('300.5');
    await expect(page.getByText('₹150.25', { exact: true })).toHaveCount(2);
    await expenseForm.description(page).fill('Supper');
    await expenseForm.amount(page).fill('450');
    await expenseForm.paidBy(page, 'Bob').click();
    await saveExpense(page, 'Save changes');
    await expect(page.getByText('Supper', { exact: true })).toBeVisible();
    await expect(page.getByText('Bob paid · split equally, 2 ways')).toBeVisible();
    await expect(page.getByText('₹450', { exact: true })).toBeVisible();
    await expect(page.getByText('2 members · 1 expense')).toBeVisible();
    await expect(page.getByText('You owe', { exact: true })).toBeVisible();
    await expect(page.getByText('₹225', { exact: true })).toBeVisible();
  });

  test('saving an expense as it was changes nothing', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    const { group } = await yash.api.seedGroup({
      name: 'Trip',
      people: ['Bob'],
      spends: [{ description: 'Dinner', amount: 30_000, paidBy: 'Yash' }],
    });
    await goToGroup(page, 'Trip');
    await page.getByText('Dinner', { exact: true }).click();
    await saveExpense(page, 'Save changes');
    await expect(groupHeader(page)).toBeVisible();
    const history = await yash.api.history(group.id);
    expect(history.map((h) => h.kind)).toEqual(['expense_added']);
  });

  test('the other device sees the change on its next refresh', async ({ person }) => {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const { group } = await alice.api.seedGroup({
      name: 'Trip',
      people: ['Bob'],
      spends: [{ description: 'Dinner', amount: 30_000, paidBy: 'Alice' }],
    });
    await joinAs(alice, group.id, bob, 'Bob');
    await goToGroup(bob.page, 'Trip');
    await expect(bob.page.getByText('Dinner', { exact: true })).toBeVisible();
    await goToGroup(alice.page, 'Trip');
    await alice.page.getByText('Dinner', { exact: true }).click();
    await expenseForm.description(alice.page).fill('Supper');
    await saveExpense(alice.page, 'Save changes');
    await expect(bob.page.getByText('Supper', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(bob.page.getByText('Dinner', { exact: true })).toHaveCount(0);
  });

  test('a split by shares opens as the amounts it came to', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    const { group, idOf } = await yash.api.seedGroup({ name: 'Trip', people: ['Bob'] });
    await yash.api.addExpense({
      groupId: group.id,
      description: 'Villa',
      amount: 30_000,
      paidByMemberId: idOf('Yash'),
      splitMode: 'shares',
      parts: [
        { memberId: idOf('Yash'), weight: 2 },
        { memberId: idOf('Bob'), weight: 1 },
      ],
    });
    await goToGroup(page, 'Trip');
    await expect(page.getByText('Yash paid · split by shares, 2 ways')).toBeVisible();
    await page.getByText('Villa', { exact: true }).click();
    await expect(page.getByText('This was split by shares. It opens as the amounts each person owes.')).toBeVisible();
    await expect(expenseForm.exact(page, 'Yash')).toHaveValue('200');
    await expect(expenseForm.exact(page, 'Bob')).toHaveValue('100');
    await expect(page.getByText('Adds up to the total.')).toBeVisible();
    await saveExpense(page, 'Save changes');
    await expect(page.getByText('Yash paid · exact amounts, 2 ways')).toBeVisible();
  });

  test('someone else’s expense can only be read; a ghost’s can be changed by anyone', async ({ person }) => {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const { group, idOf } = await alice.api.seedGroup({
      name: 'Trip',
      people: ['Bob', 'Carl'],
      spends: [{ description: 'Cab', amount: 9_000, paidBy: 'Carl' }],
    });
    await joinAs(alice, group.id, bob, 'Bob');
    await bob.api.addExpense({
      groupId: group.id,
      description: 'Dinner',
      amount: 30_000,
      paidByMemberId: idOf('Bob'),
      splitMode: 'equal',
      parts: [idOf('Alice'), idOf('Bob'), idOf('Carl')].map((memberId) => ({ memberId })),
    });
    await goToGroup(alice.page, 'Trip');
    await alice.page.getByText('Dinner', { exact: true }).click();
    await expect(alice.page.getByText('Only Bob can change this, because they paid it.')).toBeVisible();
    await expect(button(alice.page, 'Save changes')).toHaveCount(0);
    await expect(button(alice.page, 'Delete expense')).toHaveCount(0);
    await expect(expenseForm.description(alice.page)).toHaveValue('Dinner');
    await back(alice.page);
    await alice.page.getByText('Cab', { exact: true }).click();
    await expect(alice.page.getByText(/can change this, because they paid it/)).toHaveCount(0);
    await expect(button(alice.page, 'Save changes')).toBeVisible();
    await expect(button(alice.page, 'Delete expense')).toBeVisible();
    await expenseForm.amount(alice.page).fill('120');
    await saveExpense(alice.page, 'Save changes');
    await expect(alice.page.getByText('₹120', { exact: true })).toBeVisible();
  });

  test('deleting takes what it made people owe with it', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await yash.api.seedGroup({
      name: 'Trip',
      people: ['Bob'],
      spends: [
        { description: 'Dinner', amount: 30_000, paidBy: 'Yash' },
        { description: 'Cab', amount: 6_000, paidBy: 'Yash' },
      ],
    });
    await goToGroup(page, 'Trip');
    await expect(page.getByText('₹180', { exact: true })).toBeVisible();
    await page.getByText('Dinner', { exact: true }).click();
    // The warning sits under the button before the first tap; the second tap is what deletes.
    await expect(page.getByText('What it made people owe goes with it.')).toBeVisible();
    await button(page, 'Delete expense').click();
    await expect(button(page, 'Yes, delete this expense')).toBeVisible();
    await button(page, 'Cancel').click();
    await expect(button(page, 'Yes, delete this expense')).toBeHidden();
    await expect(button(page, 'Delete expense')).toBeVisible();
    await button(page, 'Delete expense').click();
    await button(page, 'Yes, delete this expense').click();
    await expect(page.getByText('2 members · 1 expense')).toBeVisible();
    await expect(page.getByText('Dinner', { exact: true })).toHaveCount(0);
    await expect(page.getByText('₹30', { exact: true })).toBeVisible();
    await page.getByText('Cab', { exact: true }).click();
    await button(page, 'Delete expense').click();
    await button(page, 'Yes, delete this expense').click();
    await expect(page.getByText('2 members · 0 expenses')).toBeVisible();
    await expect(page.getByText('No expenses yet')).toBeVisible();
    await groupTab(page, 'Settle up');
    await expect(page.getByText('All settled.')).toBeVisible();
  });

  test('a double tap on Add expense adds one', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await createGroup(page, { name: 'Trip', people: ['Bob'] });
    await openForm(page);
    await expenseForm.description(page).fill('Villa');
    await expenseForm.amount(page).fill('100');
    await button(page, 'Add expense').last().dblclick();
    await expect(groupHeader(page)).toBeVisible();
    await expect(page.getByText('2 members · 1 expense')).toBeVisible();
    const [group] = await yash.api.groups();
    expect(await yash.api.expenses(group.id)).toHaveLength(1);
  });
});
