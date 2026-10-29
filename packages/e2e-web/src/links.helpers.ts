/**
 * Helpers for the link tests (tests/links.spec.ts, tests/paylink.spec.ts):
 * a group where someone owes its maker, and the pages a link opens.
 */

import { expect, type Page } from '@playwright/test';

import type { Api } from './api';

/**
 * A group made by the caller, with `debtor` (a ghost) owing them half of
 * `spent`: the caller paid `spent` for the two of them. `others` are more
 * ghosts with nothing owed either way. Rupees unless `currency` says.
 */
export async function groupWhereGhostOwesMe(
  api: Api,
  input: { name: string; me: string; debtor: string; spent?: number; others?: string[]; currency?: string }
) {
  const spent = input.spent ?? 60_000;
  const seeded = await api.seedGroup({
    name: input.name,
    people: [input.debtor, ...(input.others ?? [])],
    currency: input.currency,
    spends: [{ description: 'Dinner', amount: spent, paidBy: input.me, between: [input.me, input.debtor] }],
  });
  return { ...seeded, owed: spent / 2 };
}

/** The group's link, made if there is none, as a token. */
export async function groupLinkToken(api: Api, groupId: string) {
  return ((await api.groupLink(groupId)) ?? (await api.createGroupLink(groupId))).token;
}

/** Opens the group's page and waits for it. */
export async function openGroupPage(page: Page, token: string) {
  await page.goto(`/g/${token}`);
  await expect(page.getByText(/shared by link$/)).toBeVisible();
}

/** Opens a pay link's page and waits for it: the brand line over a payment, or the title once it's paid or settled. */
export async function openPayPage(page: Page, token: string) {
  await page.goto(`/s/${token}`);
  await expect(page.getByText(/^(Sattle|Paid|Settled)$/).first()).toBeVisible();
}

/** The four-digit code a join request shows. */
export const JOIN_CODE = /^\d{4}$/;

/** A radio row on the join page, by the name on it. The row's accessible name includes the avatar's initials, so it's found by the name inside. */
export const who = (page: Page, name: string) => page.getByRole('radio').filter({ has: page.getByText(name, { exact: true }) });
