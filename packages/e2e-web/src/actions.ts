/**
 * The app's screens, driven the way a person drives them. Each helper does
 * one thing someone would do and waits for what they would see next.
 *
 * How react-native-web draws things, which is what the locators lean on:
 *   Button        a plain div around a text div: found by its label, exactly
 *   TextInput     an <input> with its placeholder
 *   Switch        <input role="switch" aria-label="…">
 *   Segmented     role="radiogroup" of role="radio" with aria-checked
 *   IconButton    role="button" with aria-label
 *   Card, rows    plain divs with no names: reached from a text inside them
 *                 with `ancestor`, by how many levels up the card is
 *   Modal/Sheet   drawn at the end of <body>, over the screen
 */

import { expect, type Locator, type Page } from '@playwright/test';

/** The button, chip or tab with exactly this label. */
export const button = (where: Page | Locator, label: string) => where.getByText(label, { exact: true });

/** The element `n` levels above `from`. */
export const ancestor = (from: Locator, n: number) => from.locator(`xpath=${Array(n).fill('..').join('/')}`);

/**
 * The Pressable around a button's label: where react-native-web puts
 * `aria-disabled` when the button is disabled (and draws it at 0.4 opacity).
 * Playwright won't click an aria-disabled element without `force`, which is
 * what a test wants when it checks that a disabled button does nothing.
 */
export const pressable = (where: Page | Locator, label: string) => ancestor(button(where, label), 1);

/** Asserts a button is disabled, by the attribute RNW sets. */
export const expectDisabled = (where: Page | Locator, label: string) =>
  expect(pressable(where, label)).toHaveAttribute('aria-disabled', 'true');

/** The section of a screen under this label: the label and the card beneath it. */
export const section = (where: Page | Locator, label: string) => ancestor(where.getByText(label, { exact: true }), 1);

/**
 * The card a debt is shown in on Settle up, from its first line ("You owe
 * Priya", "Priya owes you"). Card > row > words > line, so three up.
 */
export const debtCard = (page: Page, line: string) => ancestor(page.getByText(line, { exact: true }), 3);

/** A member's row under Members, from their name as shown ("Priya", "Yash (you)"). Row > words > name. */
export const memberRow = (page: Page, nameAsShown: string) => ancestor(page.getByText(nameAsShown, { exact: true }), 2);

/** One of Groups, Wallet and Account at the bottom of the app. The bar is drawn last, so the last match is its label. */
export async function tab(page: Page, name: 'Groups' | 'Wallet' | 'Account') {
  await page.getByText(name, { exact: true }).last().click();
}

/** One of a group's three parts. */
export async function groupTab(page: Page, name: 'Expenses' | 'Members' | 'Settle up') {
  await page.getByRole('radio', { name, exact: true }).click();
}

/** The group's header line: "3 members · 2 expenses". */
export const groupHeader = (page: Page) => page.getByText(/^\d+ members · \d+ expenses$/);

/**
 * A row on the groups list, by the group's name, through to the group screen.
 * The list doesn't refresh on its own, so a group seeded through the API
 * after the list came up isn't on it until `reload`.
 */
export async function openGroup(page: Page, name: string, { reload = false } = {}) {
  if (reload) await page.reload();
  await page.getByText(name, { exact: true }).first().click();
  await expect(groupHeader(page)).toBeVisible();
}

/** Back, from the header. */
export async function back(page: Page) {
  await page.getByText('‹', { exact: true }).first().click();
}

/** Skip, on the first-launch tour. */
export async function skipTour(page: Page) {
  await expect(page.getByText('Split bills without the maths')).toBeVisible();
  await button(page, 'Skip').click();
}

/** The welcome screen: a name, and that's the account. Resolves on the groups list. */
export async function makeAccount(page: Page, name: string) {
  await page.getByPlaceholder('Your name').fill(name);
  await button(page, 'Get started').click();
  await expect(page.getByText('No groups yet')).toBeVisible();
}

/**
 * New group, filled in and created, from the groups list. Resolves on the
 * group screen. `people` are everyone but the person making it.
 */
export async function createGroup(
  page: Page,
  input: { name: string; people?: string[]; currency?: 'Rupees' | 'Bitcoin'; simplifyDebts?: boolean }
) {
  await button(page, 'New group').click();
  await page.getByPlaceholder('Goa trip').fill(input.name);
  if (input.currency) await page.getByRole('radio', { name: input.currency, exact: true }).click();
  const people = input.people ?? [];
  for (let i = 0; i < people.length; i++) {
    if (i > 0) await button(page, 'Add another person').click();
    await page.getByPlaceholder('Their name').nth(i).fill(people[i]);
  }
  if (input.simplifyDebts === false) await page.getByRole('switch', { name: 'Simplify debts' }).click();
  await button(page, 'Create group').click();
  await expect(page.getByText(`${people.length + 1} members · 0 expenses`)).toBeVisible();
}

export interface SpendInput {
  description: string;
  /** As typed: rupees, or sats in a bitcoin group. */
  amount: string;
  paidBy?: string;
  split?: 'Equally' | 'By shares' | 'Exact';
  /** Who to leave out of the split. */
  exclude?: string[];
  /** By shares: how many each person gets, 1 unless named. */
  shares?: Record<string, number>;
  /** Exact: each person's amount, as typed. */
  exact?: Record<string, string>;
}

/** The expense form's fields. */
export const expenseForm = {
  description: (page: Page) => page.getByPlaceholder('Dinner at Thalassa'),
  amount: (page: Page) => page.getByPlaceholder('0').first(),
  paidBy: (page: Page, name: string) => section(page, 'Paid by').getByText(name, { exact: true }),
  split: (page: Page, mode: 'Equally' | 'By shares' | 'Exact') => section(page, 'Split').getByText(mode, { exact: true }),
  between: (page: Page, name: string) => section(page, 'Between').getByText(name, { exact: true }),
  // The steppers carry a label but no role, so they are found by the label alone.
  moreShares: (page: Page, name: string) => page.getByLabel(`One more share for ${name}`, { exact: true }),
  fewerShares: (page: Page, name: string) => page.getByLabel(`One fewer share for ${name}`, { exact: true }),
  exact: (page: Page, name: string) => page.getByRole('textbox', { name: new RegExp(`^${escape(name)}'s amount`) }),
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The expense form, filled in but not saved. */
export async function fillExpense(page: Page, input: SpendInput) {
  await expenseForm.description(page).fill(input.description);
  await expenseForm.amount(page).fill(input.amount);
  if (input.paidBy) await expenseForm.paidBy(page, input.paidBy).click();
  if (input.split) await expenseForm.split(page, input.split).click();
  for (const name of input.exclude ?? []) await expenseForm.between(page, name).click();
  for (const [name, count] of Object.entries(input.shares ?? {})) {
    for (let i = 1; i < count; i++) await expenseForm.moreShares(page, name).click();
  }
  for (const [name, amount] of Object.entries(input.exact ?? {})) await expenseForm.exact(page, name).fill(amount);
}

/** Add expense, from a group screen, filled in and saved. Resolves back on the group. */
export async function addExpense(page: Page, input: SpendInput) {
  await button(page, 'Add expense').click();
  await expect(expenseForm.description(page)).toBeVisible();
  await fillExpense(page, input);
  // The form's title is "Add expense" too; the button is the last of the two.
  await button(page, 'Add expense').last().click();
  await expect(expenseForm.description(page)).toBeHidden();
  await expect(groupHeader(page)).toBeVisible();
}

/** A two-tap button: the first tap asks, the second does it. */
export async function confirm(where: Page | Locator, label: string, confirmLabel: string) {
  await button(where, label).click();
  await button(where, confirmLabel).click();
}

/**
 * Invite, on the group screen: opens the dialog with the group's link and
 * returns the link as shown. `done` closes the dialog again.
 */
export async function inviteLink(page: Page, { done = true } = {}): Promise<string> {
  await button(page, 'Invite').click();
  const url = page.getByText(/\/g\/[A-Za-z0-9_-]+$/);
  await expect(url).toBeVisible();
  const text = (await url.textContent())!.trim();
  if (done) await button(page, 'Done').click();
  return text;
}

/** The token at the end of a group or pay link. */
export const tokenOf = (url: string) => url.split('/').pop()!;

/** Manage, on the group screen. Resolves once the settings are up. */
export async function openManage(page: Page) {
  await button(page, 'Manage').click();
  await expect(page.getByText('Manage group')).toBeVisible();
}

/** Wallet: the UPI ID saved, from wherever the app is. Resolves with Wallet still open. */
export async function saveUpiId(page: Page, upiId: string) {
  await tab(page, 'Wallet');
  const upi = section(page, 'UPI');
  await upi.getByPlaceholder('name@okhdfcbank').fill(upiId);
  await button(upi, 'Save').or(button(upi, 'Save anyway')).click();
  await expect(upi.getByText('You can be paid at')).toBeVisible();
}

/** Wallet: the Lightning address saved. Resolves with Wallet still open. */
export async function saveLightningAddress(page: Page, address: string) {
  await tab(page, 'Wallet');
  const card = section(page, 'Or a Lightning address').or(section(page, 'Lightning address'));
  await card.getByPlaceholder('you@walletofsatoshi.com').fill(address);
  await button(card, 'Save').click();
  await expect(card.getByText('You receive at')).toBeVisible();
}

/** The settle-up sheet, or a dialog, which is drawn over the screen. */
export const sheet = (page: Page) => page.locator('[aria-modal="true"]').first();

/**
 * Taps outside the sheet, which closes it. A tap while the sheet is still
 * sliding in does nothing, so it taps again until the sheet has gone.
 */
export async function closeSheet(page: Page) {
  const modal = page.locator('[aria-modal="true"]');
  await expect(modal).toBeVisible();
  await expect(async () => {
    await page.mouse.click(8, 8);
    await expect(modal).toHaveCount(0, { timeout: 700 });
  }).toPass({ timeout: 10_000 });
}

/** What the clipboard holds. The page has to be the one in front to read it. */
export async function clipboard(page: Page): Promise<string> {
  await page.bringToFront();
  return page.evaluate(() => navigator.clipboard.readText());
}

/** Everything on screen, as text, read once. For a state that is only up for a moment. */
export const screenText = (page: Page) => page.evaluate(() => document.body.innerText);

/** Waits for a simulated payment started from the app's sheet to settle, and closes the sheet. */
export async function waitForSettled(page: Page) {
  await expect(page.getByText('Settled', { exact: true })).toBeVisible({ timeout: 20_000 });
  await button(page, 'Done').click();
}
