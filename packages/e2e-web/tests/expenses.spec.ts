/**
 * Expenses: the form and its live split, each way of splitting (equally, by
 * amount, by parts, by percent, by item), what the form refuses, how typed
 * amounts are read, who may change an expense, and that every balance in
 * the app agrees with the maths.
 */

import {
  addExpense,
  back,
  button,
  closeSplit,
  createGroup,
  debtCard,
  expenseForm,
  goToGroup,
  groupHeader,
  groupTab,
  joinAs,
  memberRow,
  openGroup,
  openSplit,
  saveExpense,
  sheet,
} from '../src/actions';
import { expect, test } from '../src/fixtures';

import type { Page } from '@playwright/test';

/** Add expense, from the group screen, with the form up. */
async function openForm(page: Page) {
  await button(page, 'Add expense').click();
  await expect(expenseForm.description(page)).toBeVisible();
}

/** An expense's line under Activity: "You paid ₹100 · 4:25 pm". */
const paidLine = (page: Page, who: string, amount: string) =>
  page.getByText(new RegExp(`^${who} paid ${amount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · `));

test.describe('Split equally', () => {
  test('shows each person’s share as the amount is typed, remainder first', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Trip', people: ['Bob', 'Carl'] });
    await openForm(page);
    await expenseForm.amount(page).fill('100');
    await expect(page.getByText('Split equally between 3', { exact: true })).toBeVisible();
    await expect(page.getByText('about ₹33.33 each', { exact: true })).toBeVisible();
    await expect(page.getByText('₹33.34', { exact: true })).toHaveCount(1);
    await expect(page.getByText('₹33.33', { exact: true })).toHaveCount(2);
    await expenseForm.amount(page).fill('99');
    await expect(page.getByText('₹33 each', { exact: true })).toBeVisible();
    await expect(page.getByText('₹33', { exact: true })).toHaveCount(3);
    await openSplit(page);
    await expenseForm.between(page, 'Carl').click();
    await expect(sheet(page).getByText('₹49.50', { exact: true })).toHaveCount(2);
    await expect(sheet(page).getByText('Not in this', { exact: true })).toHaveCount(1);
    await expenseForm.between(page, 'Bob').click();
    await expect(sheet(page).getByText('₹99', { exact: true })).toHaveCount(1);
    await closeSplit(page);
    await expect(page.getByText('Split equally between 1', { exact: true })).toBeVisible();
    await expenseForm.description(page).fill('Mine');
    await saveExpense(page);
    await expect(paidLine(page, 'You', '₹99')).toBeVisible();
    await expect(page.getByText('all for Yash', { exact: true })).toBeVisible();
    await expect(page.getByText('just you', { exact: true })).toBeVisible();
    // Paid for yourself alone: nobody owes anyone.
    await expect(page.getByText('All square', { exact: true })).toBeVisible();
    await expect(page.getByText('Everyone’s square. Nothing to pay.', { exact: true })).toBeVisible();
    await groupTab(page, 'Members');
    await expect(sheet(page).getByText('settled', { exact: true })).toHaveCount(3);
  });

  test('the amount is ready to type, and Enter goes on to what it was for', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Trip' });
    await openForm(page);
    await expect(expenseForm.amount(page)).toBeFocused();
    await expenseForm.amount(page).fill('100');
    await expenseForm.amount(page).press('Enter');
    await expect(expenseForm.description(page)).toBeFocused();
  });
});

test.describe('Split by parts', () => {
  test('each person starts on one part, and the amounts follow what’s typed', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Trip', people: ['Bob', 'Carl'] });
    await openForm(page);
    await expenseForm.description(page).fill('Villa');
    await expenseForm.amount(page).fill('300');
    await openSplit(page);
    await expenseForm.split(page, 'By parts').click();
    await expect(sheet(page).getByText('Someone had twice as much? Give them 2 parts.')).toBeVisible();
    await expect(expenseForm.parts(page, 'Yash')).toHaveValue('1');
    await expect(sheet(page).getByText('₹100', { exact: true })).toHaveCount(3);
    await expenseForm.parts(page, 'Yash').fill('2');
    await expect(sheet(page).getByText('₹150', { exact: true })).toHaveCount(1);
    await expect(sheet(page).getByText('₹75', { exact: true })).toHaveCount(2);
    // No parts is no share: it says so, and won't save.
    await expenseForm.parts(page, 'Bob').fill('0');
    await expect(sheet(page).getByText('Give everyone in the split at least 1 part, or leave them out.')).toBeVisible();
    await expenseForm.parts(page, 'Bob').fill('1');
    await expenseForm.between(page, 'Carl').click();
    await expect(sheet(page).getByText('₹200', { exact: true })).toHaveCount(1);
    await expect(sheet(page).getByText('₹100', { exact: true })).toHaveCount(1);
    await expenseForm.parts(page, 'Yash').fill('99');
    await expect(sheet(page).getByText('₹297', { exact: true })).toBeVisible();
    await expect(sheet(page).getByText('₹3', { exact: true })).toBeVisible();
    await expenseForm.parts(page, 'Yash').fill('98');
    await closeSplit(page);
    await expect(page.getByText('Split by parts between 2', { exact: true })).toBeVisible();
    await saveExpense(page);
    await expect(paidLine(page, 'You', '₹300')).toBeVisible();
    await expect(page.getByText('split by shares, 2 ways', { exact: true })).toBeVisible();
    // 300 × 98/99 = ₹296.97 to Yash, ₹3.03 to Bob, which Bob owes.
    await expect(debtCard(page, 'Bob pays you').getByText('₹3.03')).toBeVisible();
  });
});

test.describe('Split by percent', () => {
  test('starts even, has to reach 100%, and saves the amounts it comes to', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Trip', people: ['Bob', 'Carl'] });
    await openForm(page);
    await expenseForm.description(page).fill('Dinner');
    await expenseForm.amount(page).fill('200');
    await openSplit(page);
    await expenseForm.split(page, 'By percent').click();
    await expect(expenseForm.percent(page, 'Yash')).toHaveValue('34');
    await expect(expenseForm.percent(page, 'Bob')).toHaveValue('33');
    await expect(sheet(page).getByText('Adds up to ₹200.', { exact: true })).toBeVisible();
    await expenseForm.percent(page, 'Yash').fill('50');
    await expect(sheet(page).getByText('116% of 100% so far.', { exact: true })).toBeVisible();
    await closeSplit(page);
    await saveExpense(page);
    await expect(page.getByText('116% of 100% so far.').first()).toBeVisible();
    await openSplit(page);
    await expenseForm.percent(page, 'Bob').fill('25');
    await expenseForm.percent(page, 'Carl').fill('25');
    await expect(sheet(page).getByText('₹100', { exact: true })).toHaveCount(1);
    await expect(sheet(page).getByText('₹50', { exact: true })).toHaveCount(2);
    await closeSplit(page);
    await saveExpense(page);
    await expect(page.getByText('exact amounts, 3 ways', { exact: true })).toBeVisible();
    await groupTab(page, 'Members');
    await expect(memberRow(page, 'Bob').getByText('₹50')).toBeVisible();
    await expect(memberRow(page, 'Yash (you)').getByText('₹100')).toBeVisible();
  });
});

test.describe('Split by amount', () => {
  test('keeps a running total and refuses a split that doesn’t add up', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Trip', people: ['Bob', 'Carl'] });
    await openForm(page);
    await expenseForm.description(page).fill('Dinner');
    await expenseForm.amount(page).fill('300');
    await openSplit(page);
    await expenseForm.split(page, 'By amount').click();
    await expect(sheet(page).getByText('₹300 still to share out.')).toBeVisible();
    await expenseForm.exact(page, 'Yash').fill('100');
    await expect(sheet(page).getByText('₹200 still to share out.')).toBeVisible();
    await expenseForm.exact(page, 'Bob').fill('100');
    await expect(sheet(page).getByText('₹100 still to share out.')).toBeVisible();
    await expenseForm.exact(page, 'Carl').fill('150');
    await expect(sheet(page).getByText('₹50 more than the total.')).toBeVisible();
    await closeSplit(page);
    await saveExpense(page);
    await expect(page.getByText('₹50 more than the total.').first()).toBeVisible();
    await expect(expenseForm.description(page)).toBeVisible();
    await openSplit(page);
    await expenseForm.exact(page, 'Carl').fill('');
    await expect(sheet(page).getByText('₹100 still to share out.')).toBeVisible();
    await expenseForm.exact(page, 'Carl').fill('100');
    await expect(sheet(page).getByText('Adds up to ₹300.')).toBeVisible();
    await closeSplit(page);
    await saveExpense(page);
    await expect(page.getByText('exact amounts, 3 ways', { exact: true })).toBeVisible();
    await groupTab(page, 'Members');
    await expect(memberRow(page, 'Yash (you)').getByText('₹200')).toBeVisible();
    await expect(memberRow(page, 'Bob').getByText('₹100')).toBeVisible();
    await expect(memberRow(page, 'Carl').getByText('₹100')).toBeVisible();
  });

  test('a person taken out of the split keeps no field', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Trip', people: ['Bob'] });
    await openForm(page);
    await openSplit(page);
    await expenseForm.split(page, 'By amount').click();
    await expect(expenseForm.exact(page, 'Bob')).toBeVisible();
    await expenseForm.between(page, 'Bob').click();
    await expect(expenseForm.exact(page, 'Bob')).toHaveCount(0);
    await expect(expenseForm.exact(page, 'Yash')).toBeVisible();
  });
});

test.describe('Split by item', () => {
  test('shares each line between who had it, a paisa at a time, and saves the amounts', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await createGroup(page, { name: 'Trip', people: ['Bob', 'Carl'] });
    await openForm(page);
    await expenseForm.description(page).fill('Seafood dinner');
    await openSplit(page);
    await button(sheet(page), 'Split by item').click();
    await expect(page.getByText('Seafood dinner · tap who had what', { exact: true })).toBeVisible();
    await expect(page.getByText('Add what was on the bill, then tap who had each thing.')).toBeVisible();

    await page.getByRole('textbox', { name: 'Item 1', exact: true }).fill('Thali');
    await page.getByRole('textbox', { name: 'Price of Thali', exact: true }).fill('640');
    await expect(page.getByText('Thali has nobody on it yet. Tap whoever had it.')).toBeVisible();
    await page.getByRole('checkbox', { name: 'Yash had Thali', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Bob had Thali', exact: true }).click();
    await expect(page.getByText('₹320 each', { exact: true })).toBeVisible();

    await button(page, 'Add item').click();
    await page.getByRole('textbox', { name: 'Item 2', exact: true }).fill('Wine');
    await page.getByRole('textbox', { name: 'Price of Wine', exact: true }).fill('100');
    for (const name of ['Yash', 'Bob', 'Carl']) {
      await page.getByRole('checkbox', { name: `${name} had Wine`, exact: true }).click();
    }
    // ₹100 three ways: the odd paisa goes to the first.
    await expect(page.getByText('Everyone’s share adds up to ₹740.')).toBeVisible();
    await expect(page.getByText('₹353.34', { exact: true })).toBeVisible();
    await expect(page.getByText('₹353.33', { exact: true })).toBeVisible();
    await expect(page.getByText('₹33.33', { exact: true })).toBeVisible();

    await button(page, 'Save ₹740').click();
    await expect(groupHeader(page)).toBeVisible();
    await expect(page.getByText('exact amounts, 3 ways', { exact: true })).toBeVisible();
    const [group] = await yash.api.groups();
    const [expense] = await yash.api.expenses(group.id);
    expect(expense).toMatchObject({ description: 'Seafood dinner', amount: 74_000, splitMode: 'exact' });
    expect(expense.parts.map((p) => p.amount).sort((a, b) => a - b)).toEqual([3_333, 35_333, 35_334]);
  });

  test('won’t save a line nobody had, and back keeps the form as it was', async ({ person }) => {
    const { page } = await person('Yash');
    await createGroup(page, { name: 'Trip', people: ['Bob'] });
    await openForm(page);
    await expenseForm.amount(page).fill('50');
    await openSplit(page);
    await button(sheet(page), 'Split by item').click();
    await page.getByRole('textbox', { name: 'Price of Item 1', exact: true }).fill('80');
    await expect(page.getByText('Item 1 has nobody on it yet. Tap whoever had it.')).toBeVisible();
    await expect(button(page, 'Save ₹80').locator('..')).toHaveAttribute('aria-disabled', 'true');
    await back(page);
    await expect(expenseForm.amount(page)).toHaveValue('50');
    await expect(page.getByText('Split equally between 2', { exact: true })).toBeVisible();
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
    await openSplit(page);
    await expenseForm.between(page, 'Yash').click();
    await expenseForm.between(page, 'Bob').click();
    await closeSplit(page);
    await expect(page.getByText('Nobody in the split yet', { exact: true })).toBeVisible();
    await saveExpense(page);
    await expect(page.getByText('Pick at least one person.').first()).toBeVisible();
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
      await expect(paidLine(page, 'You', shown)).toBeVisible();
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
    await button(page, 'Add expense').click();
    await expect(page.getByText('Paid by You · today', { exact: true })).toBeVisible();
    await back(page);
    await addExpense(page, { description: 'Villa', amount: '100' });
    await expect(paidLine(page, 'You', '₹100')).toBeVisible();
    await addExpense(page, { description: 'Cab', amount: '50', paidBy: 'Bob' });
    await expect(paidLine(page, 'Bob', '₹50')).toBeVisible();
    await expect(page.getByText('split equally, 2 ways', { exact: true })).toHaveCount(2);
    await expect(page.getByText(/^You’re owed/)).toBeVisible();
    await expect(debtCard(page, 'Bob pays you').getByText('₹25')).toBeVisible();
  });

  test('whoever adds the expense is the payer unless they say otherwise, on any device', async ({ person }) => {
    const alice = await person('Alice');
    const bob = await person('Bob');
    const { group } = await alice.api.seedGroup({ name: 'Trip', people: ['Bob'] });
    await joinAs(alice, group.id, bob, 'Bob');
    await goToGroup(bob.page, 'Trip');
    await addExpense(bob.page, { description: 'Cab', amount: '60' });
    await expect(paidLine(bob.page, 'You', '₹60')).toBeVisible();
    await goToGroup(alice.page, 'Trip');
    await expect(paidLine(alice.page, 'Bob', '₹60')).toBeVisible();
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
    await expect(page.getByText(/^You’re owed/)).toBeVisible();
    await expect(page.getByText('₹155', { exact: true })).toBeVisible();
    // Spent ₹390 together; Yash's part is ₹100 of the villa and ₹45 of the cab.
    await expect(page.getByText(/^Spent together ₹390 · your share ₹145$/)).toBeVisible();
    await groupTab(page, 'Members');
    await expect(memberRow(page, 'Yash (you)').getByText('gets back')).toBeVisible();
    await expect(memberRow(page, 'Yash (you)').getByText('₹155')).toBeVisible();
    await expect(memberRow(page, 'Bob').getByText('owes')).toBeVisible();
    await expect(memberRow(page, 'Bob').getByText('₹100')).toBeVisible();
    await expect(memberRow(page, 'Carl').getByText('owes')).toBeVisible();
    await expect(memberRow(page, 'Carl').getByText('₹55')).toBeVisible();
    await groupTab(page, 'Settle up');
    await expect(debtCard(page, 'Bob pays you').getByText('₹100')).toBeVisible();
    await expect(debtCard(page, 'Carl pays you').getByText('₹55')).toBeVisible();
    await expect(page.getByText(/^You pay/)).toHaveCount(0);
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
    await expect(page.getByText('Edit expense in', { exact: true })).toBeVisible();
    await expect(expenseForm.description(page)).toHaveValue('Dinner');
    await expect(expenseForm.amount(page)).toHaveValue('300.5');
    await expect(page.getByText('₹150.25', { exact: true })).toHaveCount(2);
    await expenseForm.description(page).fill('Supper');
    await expenseForm.amount(page).fill('450');
    await openSplit(page);
    await expenseForm.paidBy(page, 'Bob').click();
    await closeSplit(page);
    await saveExpense(page, 'Save changes');
    await expect(page.getByText('Supper', { exact: true })).toBeVisible();
    await expect(paidLine(page, 'Bob', '₹450')).toBeVisible();
    await expect(page.getByText(/^You owe/)).toBeVisible();
    await expect(debtCard(page, 'You pay Bob').getByText('₹225')).toBeVisible();
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

  test('a split by parts opens as the amounts it came to', async ({ person }) => {
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
    await expect(page.getByText('split by shares, 2 ways', { exact: true })).toBeVisible();
    await page.getByText('Villa', { exact: true }).click();
    await expect(page.getByText('This was split by parts. It opens as the amounts each person owes.')).toBeVisible();
    await expect(page.getByText('Split by amount between 2', { exact: true })).toBeVisible();
    await openSplit(page);
    await expect(expenseForm.exact(page, 'Yash')).toHaveValue('200');
    await expect(expenseForm.exact(page, 'Bob')).toHaveValue('100');
    await expect(sheet(page).getByText('Adds up to ₹300.')).toBeVisible();
    await closeSplit(page);
    await saveExpense(page, 'Save changes');
    await expect(page.getByText('exact amounts, 2 ways', { exact: true })).toBeVisible();
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
    await expect(paidLine(alice.page, 'Carl', '₹120')).toBeVisible();
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
    await expect(page.getByText('₹180', { exact: true }).first()).toBeVisible();
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
    await expect(groupHeader(page)).toBeVisible();
    await expect(page.getByText('Dinner', { exact: true })).toHaveCount(0);
    await expect(debtCard(page, 'Bob pays you').getByText('₹30')).toBeVisible();
    await page.getByText('Cab', { exact: true }).click();
    await button(page, 'Delete expense').click();
    await button(page, 'Yes, delete this expense').click();
    await expect(page.getByText('No expenses yet')).toBeVisible();
    await expect(page.getByText('Nothing yet. Add the first one below.')).toBeVisible();
    await expect(page.getByText('Who pays whom', { exact: true })).toHaveCount(0);
  });

  test('a double tap on Save adds one', async ({ person }) => {
    const yash = await person('Yash');
    const { page } = yash;
    await createGroup(page, { name: 'Trip', people: ['Bob'] });
    await openForm(page);
    await expenseForm.description(page).fill('Villa');
    await expenseForm.amount(page).fill('100');
    await button(page, 'Save').dblclick();
    await expect(groupHeader(page)).toBeVisible();
    await expect(page.getByText('Villa', { exact: true })).toHaveCount(1);
    const [group] = await yash.api.groups();
    expect(await yash.api.expenses(group.id)).toHaveLength(1);
  });
});
