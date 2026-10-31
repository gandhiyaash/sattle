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

import type { Person } from './fixtures';

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

/** Asserts a button is greyed out, by the attribute RNW sets: given the label's locator, or where to find it and its text. */
export function expectDisabled(where: Page | Locator, label?: string) {
  const text = label === undefined ? (where as Locator) : button(where, label);
  return expect(ancestor(text, 1)).toHaveAttribute('aria-disabled', 'true');
}

/** The section of a screen under this label: the label and the card beneath it. */
export const section = (where: Page | Locator, label: string) => ancestor(where.getByText(label, { exact: true }), 1);

/**
 * A debt in Who pays whom on the group screen, with what's under it (a UPI
 * payment to answer, Mark as settled), from its line: "You pay Priya",
 * "Priya pays you", "Aman pays Riya". Debt > row > line, so two up.
 */
export const debtCard = (page: Page, line: string) => ancestor(page.getByText(line, { exact: true }), 2);

/** A member's row under In this group, in Add people, from their name as shown ("Priya", "Yash (you)"). Row > words > name. */
export const memberRow = (page: Page, nameAsShown: string) => ancestor(page.getByText(nameAsShown, { exact: true }), 2);

/** One of Groups, Wallet and Account at the bottom of the app. The bar is drawn last, so the last match is its label. */
export async function tab(page: Page, name: 'Groups' | 'Wallet' | 'Account') {
  await page.getByText(name, { exact: true }).last().click();
}

/**
 * Add people, from the cover of the group screen: the sheet with people
 * waiting to join, the group's link, adding someone by name, and everyone
 * in the group with where they stand. Resolves with the sheet up.
 */
export async function openPeople(page: Page) {
  await page.getByRole('button', { name: /^Add people/ }).click();
  await expect(page.getByText('Share the group link', { exact: true })).toBeVisible();
}

/**
 * Where a group's old tabs went. Members is in Add people; what Expenses and
 * Settle up held, the activity and who pays whom, is on the group screen
 * itself, so going to either just leaves Add people if it's up.
 */
export async function groupTab(page: Page, name: 'Expenses' | 'Members' | 'Settle up') {
  const up = await page.getByText('Share the group link', { exact: true }).isVisible();
  if (name === 'Members') {
    if (!up) await openPeople(page);
  } else if (up) {
    await closePeople(page);
  }
}

/**
 * Someone asking to join shows as a count on Add people, on the group's
 * cover: waits for it (the screen reads the group again every 4 s), then
 * opens Add people, where they wait to be let in.
 */
export async function waitingToJoin(page: Page) {
  await expect(page.getByRole('button', { name: /waiting to join$/ })).toBeVisible({ timeout: 15_000 });
  if (!(await page.getByText('Share the group link', { exact: true }).isVisible())) await openPeople(page);
}

/** Done, at the bottom of Add people. */
export async function closePeople(page: Page) {
  await sheet(page).getByText('Done', { exact: true }).last().click();
  await expect(page.getByText('Share the group link', { exact: true })).toBeHidden();
}

/** The group screen is up: its cover has Manage on it. */
export const groupHeader = (page: Page) => page.getByRole('button', { name: 'Manage group', exact: true });

/** Who is in the group, as the cover lists them: "You, Bob, Carl". */
export const memberLine = (page: Page, line: string) => page.getByText(line, { exact: true });

/** "1 member", "3 members": how the app counts. */
export const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

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

/** Back, from the header: the group's cover, the expense form's ×, or ‹ on the rest. */
export async function back(page: Page) {
  await page
    .getByRole('button', { name: /^(Back|Back to .+|Close without saving)$/ })
    .or(page.getByText('‹', { exact: true }))
    .first()
    .click();
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
  await expect(page.getByText('What are you splitting?')).toBeVisible();
}

/**
 * New group, filled in and created, from the groups list. Resolves on the
 * group screen, with the Add people it opens on closed again. `people` are
 * everyone but the person making it.
 */
export async function createGroup(
  page: Page,
  input: { name: string; people?: string[]; currency?: 'Rupees' | 'Bitcoin'; simplifyDebts?: boolean }
) {
  await button(page, 'New group').click();
  await page.getByPlaceholder('Name your group').fill(input.name);
  if (input.currency) await keptIn(page, input.currency);
  const people = input.people ?? [];
  for (const name of people) {
    await page.getByPlaceholder('Add a name').fill(name);
    await page.getByPlaceholder('Add a name').press('Enter');
  }
  await button(page, 'Create and share the link').click();
  await closePeople(page);
  await expect(page.getByText('No expenses yet', { exact: true })).toBeVisible();
  // New groups start without it; the tests were written for groups that simplify unless they say not to.
  if (input.simplifyDebts !== false) {
    await openManage(page);
    await page.getByRole('switch', { name: 'Simplify debts' }).click();
    await expect(page.getByText('Debts are combined, so everyone settles up in as few payments as possible.')).toBeVisible();
    await back(page);
    await expect(groupHeader(page)).toBeVisible();
  }
}

/** The currency chip on New group's cover, tapped until it says this one. */
export async function keptIn(page: Page, currency: 'Rupees' | 'Bitcoin') {
  const chip = page.getByRole('button', { name: /^Kept in / });
  for (let i = 0; i < 3; i++) {
    if ((await chip.getAttribute('aria-label')) === `Kept in ${currency}. Change`) return;
    await chip.click();
  }
  await expect(chip).toHaveAttribute('aria-label', `Kept in ${currency}. Change`);
}

/** The app reopened on its groups list, so a group seeded through the API is there, then that group. */
export async function goToGroup(page: Page, name: string) {
  await page.goto('/');
  await openGroup(page, name);
}

/** `guest` joins `host`'s group through its link, as the ghost called `asName`. Returns their member. */
export async function joinAs(host: Person, groupId: string, guest: Person, asName: string) {
  const link = (await host.api.groupLink(groupId)) ?? (await host.api.createGroupLink(groupId));
  const view = await host.api.as(null).joinView(link.token);
  const ghost = view.members.find((m) => m.name === asName);
  if (!ghost) throw new Error(`${asName} isn't offered on the join page`);
  return guest.api.join(link.token, { ref: ghost.ref });
}

export type SplitWay = 'Equally' | 'By amount' | 'By parts' | 'By percent';

export interface SpendInput {
  description: string;
  /** As typed: rupees, or sats in a bitcoin group. */
  amount: string;
  paidBy?: string;
  split?: SplitWay;
  /** Who to leave out of the split. */
  exclude?: string[];
  /** By parts: how many each person gets, 1 unless named. */
  shares?: Record<string, number>;
  /** By amount: each person's amount, as typed. */
  exact?: Record<string, string>;
}

/**
 * The expense form's fields. Who paid and how it's split are in the sheet
 * Split differently opens (`openSplit`), so those need it up first.
 */
export const expenseForm = {
  description: (page: Page) => page.getByPlaceholder('What was it for?'),
  amount: (page: Page) => page.getByPlaceholder('0').first(),
  paidBy: (page: Page, name: string) => sheet(page).getByRole('radio', { name, exact: true }),
  split: (page: Page, way: SplitWay) => sheet(page).getByRole('radio', { name: way, exact: true }),
  between: (page: Page, name: string) => page.getByRole('checkbox', { name: `Include ${name}`, exact: true }),
  parts: (page: Page, name: string) => page.getByRole('textbox', { name: `${name}'s parts`, exact: true }),
  percent: (page: Page, name: string) => page.getByRole('textbox', { name: `${name}'s percent`, exact: true }),
  exact: (page: Page, name: string) => page.getByRole('textbox', { name: new RegExp(`^${escape(name)}'s amount`) }),
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Split differently, on the expense form: the sheet with who paid and how to split. */
export async function openSplit(page: Page) {
  await button(page, 'Split differently').click();
  await expect(page.getByText('Who paid, how to split', { exact: true })).toBeVisible();
}

/** Done, on that sheet. */
export async function closeSplit(page: Page) {
  await button(sheet(page), 'Done').click();
  await expect(page.getByText('Who paid, how to split', { exact: true })).toBeHidden();
}

/** The expense form, filled in but not saved. */
export async function fillExpense(page: Page, input: SpendInput) {
  await expenseForm.amount(page).fill(input.amount);
  await expenseForm.description(page).fill(input.description);
  const inSheet = input.paidBy || input.split || input.exclude?.length || input.shares || input.exact;
  if (!inSheet) return;
  await openSplit(page);
  if (input.paidBy) await expenseForm.paidBy(page, input.paidBy).click();
  if (input.split) await expenseForm.split(page, input.split).click();
  for (const name of input.exclude ?? []) await expenseForm.between(page, name).click();
  for (const [name, n] of Object.entries(input.shares ?? {})) await expenseForm.parts(page, name).fill(String(n));
  for (const [name, amount] of Object.entries(input.exact ?? {})) await expenseForm.exact(page, name).fill(amount);
  await closeSplit(page);
}

/** Saves the expense form, from its top corner. */
export async function saveExpense(page: Page, label: 'Save' | 'Save changes' = 'Save') {
  await button(page, label).last().click();
}

/** Add expense, from a group screen, filled in and saved. Resolves back on the group. */
export async function addExpense(page: Page, input: SpendInput) {
  await button(page, 'Add expense').click();
  await expect(expenseForm.description(page)).toBeVisible();
  await fillExpense(page, input);
  await saveExpense(page);
  await expect(expenseForm.description(page)).toBeHidden();
  await expect(groupHeader(page)).toBeVisible();
}

/** A two-tap button: the first tap asks, the second does it. */
export async function confirm(where: Page | Locator, label: string, confirmLabel: string) {
  await button(where, label).click();
  await button(where, confirmLabel).click();
}

/**
 * Add people, on the group screen: opens the sheet with the group's link and
 * returns the link as shown. `done` closes the sheet again.
 */
export async function inviteLink(page: Page, { done = true } = {}): Promise<string> {
  await openPeople(page);
  const url = page.getByText(/\/g\/[A-Za-z0-9_-]+$/);
  await expect(url).toBeVisible();
  const text = (await url.textContent())!.trim();
  if (done) await closePeople(page);
  return text;
}

/** The token at the end of a group or pay link. */
export const tokenOf = (url: string) => url.split('/').pop()!;

/** ⋯ on the group's cover. Resolves once the settings are up. */
export async function openManage(page: Page) {
  await page.getByRole('button', { name: 'Manage group', exact: true }).click();
  await expect(page.getByText('Manage group', { exact: true })).toBeVisible();
}

/** Wallet: the UPI ID saved, from wherever the app is. Resolves with Wallet still open. */
export async function saveUpiId(page: Page, upiId: string) {
  await tab(page, 'Wallet');
  const upi = section(page, 'UPI');
  await upi.getByPlaceholder('name@okhdfcbank').fill(upiId);
  await button(upi, 'Save').or(button(upi, 'Save anyway')).click();
  await expect(upi.getByText('You can be paid at')).toBeVisible();
}

/** The sheet drawn over the screen: settling up, a history entry, a dialog. The last one when one is over another. */
export const sheet = (page: Page) => page.locator('[aria-modal="true"]').last();

/** One row of a breakdown: its label and what's beside it. */
export const breakdownRow = (where: Page | Locator, label: string) => ancestor(where.getByText(label, { exact: true }), 1);

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
