/**
 * Helpers for the settle-up specs: two people in one group, each on their
 * own device, and the small things the sheet tests do over and over.
 */

import { expect, type BrowserContext, type Page } from '@playwright/test';

import { clipboard, closeSheet, groupTab, openGroup, screenText } from './actions';
import type { Api } from './api';
import type { Device, DeviceOptions } from './fixtures';

export type DeviceFn = (opts?: DeviceOptions) => Promise<Device>;

export interface Who {
  name: string;
  token: string;
  userId: string;
  api: Api;
  page: Page;
  context: BrowserContext;
}

/** An account and a device holding its token, not yet on any page. */
export async function enter(api: Api, device: DeviceFn, name: string, opts: Omit<DeviceOptions, 'token'> = {}): Promise<Who> {
  const { user, token } = await api.account(name);
  const { page, context } = await device({ ...opts, token });
  return { name, token, userId: user.id, api: api.as(token), page, context };
}

/** The groups list, freshly loaded. */
export async function home(who: Who) {
  await who.page.goto('/');
  await expect(who.page.getByText('Groups', { exact: true }).first()).toBeVisible();
}

/** Into a group from a fresh groups list, and onto one of its tabs. */
export async function intoGroup(who: Who, group: string, tab?: 'Expenses' | 'Members' | 'Settle up') {
  await home(who);
  await openGroup(who.page, group);
  if (tab) await groupTab(who.page, tab);
}

export interface Spend {
  description: string;
  /** Minor units: paise, or sats. */
  amount: number;
  paidBy: string;
  between?: string[];
}

/**
 * Two people in one group: `a` makes it with `b` and `others` as ghosts, and
 * `b` joins by the group's link, so both have accounts in it. Neither device
 * has opened a page yet.
 */
export async function duo(
  api: Api,
  device: DeviceFn,
  input: {
    group?: string;
    currency?: 'INR' | 'BTC';
    simplifyDebts?: boolean;
    others?: string[];
    spends?: Spend[];
    aName?: string;
    bName?: string;
    a?: Omit<DeviceOptions, 'token'>;
    b?: Omit<DeviceOptions, 'token'>;
  } = {}
) {
  const a = await enter(api, device, input.aName ?? 'Yash', input.a);
  const b = await enter(api, device, input.bName ?? 'Priya', input.b);
  const seeded = await a.api.seedGroup({
    name: input.group ?? 'Goa trip',
    people: [b.name, ...(input.others ?? [])],
    currency: input.currency,
    simplifyDebts: input.simplifyDebts,
    spends: input.spends,
  });
  const link = await a.api.createGroupLink(seeded.group.id);
  const ref = (await api.joinView(link.token)).members.find((m) => m.name === b.name)!.ref;
  await b.api.join(link.token, { ref });
  return { a, b, group: seeded.group, groupName: seeded.group.name, members: seeded.members, idOf: seeded.idOf, link };
}

// The clipboard, the screen's text and closing the sheet live in actions.ts now; the specs still import them from here.
export { clipboard, closeSheet, screenText };

/** The whole seconds the countdown reads, from "… locked for 1:29". */
export const countdownOf = (text: string) => /for (\d+):(\d\d)/.exec(text);
