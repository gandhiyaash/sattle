/**
 * Helpers for the groups, expenses and history specs: a second person joining
 * a group through its link, the expense form saved without tripping over the
 * screen title, and the app reopened on a group after seeding through the API.
 */

import { expect, type Locator, type Page } from '@playwright/test';

import { ancestor, button, expenseForm, fillExpense, groupHeader, openGroup, type SpendInput } from './actions';
import type { Person } from './fixtures';

/** Whether a button is greyed out: react-native-web marks a disabled Pressable aria-disabled. */
export const disabled = (label: Locator) => expect(ancestor(label, 1)).toHaveAttribute('aria-disabled', 'true');

/** The app reopened on its groups list, so a group seeded through the API is there, then that group. */
export async function goToGroup(page: Page, name: string) {
  await page.goto('/');
  await openGroup(page, name);
}

/**
 * Saves the expense form. "Add expense" is both the screen's title and its
 * button, so the button is the later of the two.
 */
export async function saveExpense(page: Page, label: 'Add expense' | 'Save changes' = 'Add expense') {
  await button(page, label).last().click();
}

/** Add expense, from a group screen, filled in and saved. Resolves back on the group. */
export async function addSpend(page: Page, input: SpendInput) {
  await button(page, 'Add expense').click();
  await expect(expenseForm.description(page)).toBeVisible();
  await fillExpense(page, input);
  await saveExpense(page);
  await expect(expenseForm.description(page)).toBeHidden();
  await expect(groupHeader(page)).toBeVisible();
}

/** `guest` joins `host`'s group through its link, as the ghost called `asName`. Returns their member. */
export async function joinAs(host: Person, groupId: string, guest: Person, asName: string) {
  const link = (await host.api.groupLink(groupId)) ?? (await host.api.createGroupLink(groupId));
  const view = await host.api.as(null).joinView(link.token);
  const ghost = view.members.find((m) => m.name === asName);
  if (!ghost) throw new Error(`${asName} isn't offered on the join page`);
  return guest.api.join(link.token, { ref: ghost.ref });
}

/** The sheet drawn over the screen: the settle-up sheet, or a history entry. */
export const sheet = (page: Page) => page.locator('[aria-modal="true"]').last();

/** One row of a breakdown: its label and what's beside it. */
export const breakdownRow = (where: Page | Locator, label: string) => ancestor(where.getByText(label, { exact: true }), 1);
