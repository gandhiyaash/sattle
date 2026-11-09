/**
 * The Activity tab: every group's expenses, payments and changes in one list,
 * newest first, each saying which group, who did it and what it did for you,
 * and opening that group. A group's changes are in its History too. And the
 * bar Activity sits on, which is only on the three tabs.
 */

import { ancestor, back, button, groupHeader, openGroup, tab } from '../src/actions';
import { expect, test } from '../src/fixtures';

test.describe('Activity', () => {
  test('lists every group’s expenses, newest first, with what each did for you', async ({ person }) => {
    const { page, api } = await person('Yash');
    await api.seedGroup({ name: 'Goa trip', people: ['Om'], spends: [{ description: 'Dinner', amount: 60_000, paidBy: 'Yash' }] });
    await api.seedGroup({ name: 'Flat', people: ['Riya'], spends: [{ description: 'Rent', amount: 200_000, paidBy: 'Riya' }] });
    await page.reload();
    await tab(page, 'Activity');

    await expect(page.getByText('Today', { exact: true })).toBeVisible();
    expect(await page.getByText(/^(Dinner|Rent)$/).allTextContents()).toEqual(['Rent', 'Dinner']);

    const dinner = ancestor(page.getByText('Dinner', { exact: true }), 2);
    await expect(dinner.getByText('Goa trip · Added by you')).toBeVisible();
    await expect(dinner.getByText('₹300', { exact: true })).toBeVisible();
    await expect(dinner.getByText('you lent', { exact: true })).toBeVisible();

    const rent = ancestor(page.getByText('Rent', { exact: true }), 2);
    await expect(rent.getByText('Flat · Added by you · Riya paid')).toBeVisible();
    await expect(rent.getByText('₹1,000', { exact: true })).toBeVisible();
    await expect(rent.getByText('you borrowed', { exact: true })).toBeVisible();
  });

  test('a line opens its group, without the bar, and back comes to Activity', async ({ person }) => {
    const { page, api } = await person('Yash');
    await api.seedGroup({ name: 'Goa trip', people: ['Om'], spends: [{ description: 'Dinner', amount: 60_000, paidBy: 'Yash' }] });
    await page.reload();
    await tab(page, 'Activity');
    await page.getByText('Dinner', { exact: true }).click();

    await expect(groupHeader(page)).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await back(page);
    await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Dinner', { exact: true })).toBeVisible();
  });

  test('changes to a group say who made them, here and in the group’s History', async ({ person }) => {
    const { page, api } = await person('Yash');
    const { group } = await api.seedGroup({ name: 'Goa trip', people: ['Om'], spends: [{ description: 'Dinner', amount: 60_000, paidBy: 'Yash' }] });
    await api.put(`/groups/${group.id}`, { simplifyDebts: false });
    await api.put(`/groups/${group.id}`, { name: 'Goa 2026' });
    // Saying what it already is changes nothing, and adds no line.
    await api.put(`/groups/${group.id}`, { simplifyDebts: false });
    await page.reload();

    await tab(page, 'Activity');
    expect(await page.getByText(/^You (renamed|turned)/).allTextContents()).toEqual([
      'You renamed the group to “Goa 2026”',
      'You turned off Simplify debts',
    ]);
    await expect(ancestor(page.getByText('You turned off Simplify debts', { exact: true }), 2).getByText('Goa 2026', { exact: true })).toBeVisible();

    await tab(page, 'Groups');
    await openGroup(page, 'Goa 2026');
    await button(page, 'See all').click();
    await expect(page.getByText('Yash renamed the group to “Goa 2026”', { exact: true })).toBeVisible();
    await expect(page.getByText('Yash turned off Simplify debts', { exact: true })).toBeVisible();
    await expect(page.getByText('Dinner', { exact: true })).toBeVisible();
  });

  test('says so when nothing has happened yet', async ({ person }) => {
    const { page } = await person('Yash');
    await tab(page, 'Activity');
    await expect(page.getByText('Nothing yet', { exact: true })).toBeVisible();
    await expect(page.getByText('Expenses, payments and changes in your groups show up here.')).toBeVisible();
  });
});

test.describe('the bar', () => {
  test('has Groups, Activity and Account, and marks the one that’s open', async ({ person }) => {
    const { page } = await person('Yash');
    const bar = page.getByRole('tablist');
    for (const name of ['Groups', 'Activity', 'Account']) await expect(bar.getByRole('tab', { name, exact: true })).toBeVisible();
    await expect(bar.getByRole('tab', { name: 'Wallet' })).toHaveCount(0);
    await expect(bar.getByRole('tab', { name: 'Groups', exact: true })).toHaveAttribute('aria-selected', 'true');

    await tab(page, 'Account');
    await expect(bar.getByRole('tab', { name: 'Account', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(bar.getByRole('tab', { name: 'Groups', exact: true })).toHaveAttribute('aria-selected', 'false');

    // A page under Account is deeper: no bar, and back is the way out.
    await page.getByText('Currencies', { exact: true }).click();
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await back(page);
    await expect(bar).toBeVisible();
  });
});
