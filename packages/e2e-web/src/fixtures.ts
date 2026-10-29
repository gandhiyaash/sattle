/**
 * The fixtures every test builds on.
 *
 *   api      the API, spoken to directly (src/api.ts)
 *   device   a browser with a given starting state: a brand-new phone, or one
 *            that has seen the tour, or one that holds an account's token
 *   person   an account made through the API, open in its own browser on the
 *            groups list, with an Api bound to its token for seeding and
 *            checking. Two people in one test are two devices talking to the
 *            same group, which is where most of what the app does happens.
 *
 * Every test makes its own accounts and groups, so the tests share one
 * server and run side by side without seeing each other.
 */

import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';

import { Api } from './api';
import { API_URL, WEB_URL } from './env';

export type Currency = 'INR' | 'BTC';

export interface DeviceOptions {
  /** Whether this device has seen the first-launch tour. Default true: most tests start past it. */
  toured?: boolean;
  /** An account's token, as a device signed in with it holds it. */
  token?: string;
  /** The currencies this device's owner uses, as the Account screen stores them. Default: both. */
  currencies?: Currency[];
  /** Light or dark, as the Wallet screen stores it. */
  appearance?: 'system' | 'light' | 'dark';
  /**
   * The browser's share sheet. `none` (the default) is a browser without one,
   * like most on a computer: the app copies a link instead and says so.
   * `dismissed` is a sheet that opens and is closed without sending.
   * Headless Chrome itself has a sheet that never answers, so neither test
   * runs against it as it is.
   */
  shareSheet?: 'none' | 'dismissed';
}

export interface Device {
  page: Page;
  context: BrowserContext;
}

export interface Person extends Device {
  name: string;
  token: string;
  userId: string;
  /** The API, as this person. */
  api: Api;
}

type Fixtures = {
  api: Api;
  device: (opts?: DeviceOptions) => Promise<Device>;
  person: (name: string, opts?: PersonOptions) => Promise<Person>;
};

export interface PersonOptions extends Omit<DeviceOptions, 'token'> {
  /**
   * Set up what the person should already have, through the API as them,
   * before their browser opens: a group, some spends. The groups list is then
   * read once, with it all there, so nothing has to be reloaded afterwards.
   */
  seed?: (api: Api) => Promise<void>;
}

export const test = base.extend<Fixtures>({
  api: async ({}, use) => {
    const api = await Api.create(API_URL);
    await use(api);
    await api.dispose();
  },

  device: async ({ browser, contextOptions }, use) => {
    const opened: BrowserContext[] = [];
    await use(async (opts = {}) => {
      const stored: Array<{ name: string; value: string }> = [];
      if (opts.toured ?? true) stored.push({ name: 'sattle.toured', value: '1' });
      if (opts.token) stored.push({ name: 'sattle.token', value: opts.token });
      if (opts.currencies) {
        stored.push({ name: 'sattle.currencies', value: JSON.stringify({ uses: opts.currencies, newGroups: opts.currencies[0] }) });
      }
      if (opts.appearance) stored.push({ name: 'sattle.appearance', value: opts.appearance });
      const context = await browser.newContext({
        ...contextOptions,
        permissions: ['clipboard-read', 'clipboard-write'],
        // Set once, as the app itself would have stored them; what the app writes afterwards stays.
        storageState: { cookies: [], origins: stored.length ? [{ origin: WEB_URL, localStorage: stored }] : [] },
      });
      opened.push(context);
      // See DeviceOptions.shareSheet: a browser without one, or one that is always closed unsent.
      await context.addInitScript((dismissed) => {
        const nav = Navigator.prototype as unknown as Record<string, unknown>;
        delete nav.share;
        if (dismissed) {
          Object.defineProperty(nav, 'share', {
            value: () => Promise.reject(Object.assign(new Error('dismissed'), { name: 'AbortError' })),
            configurable: true,
          });
        }
      }, opts.shareSheet === 'dismissed');
      const page = await context.newPage();
      return { page, context };
    });
    for (const context of opened) await context.close();
  },

  person: async ({ api, device }, use) => {
    await use(async (name, opts = {}) => {
      const { user, token } = await api.account(name);
      const mine = api.as(token);
      if (opts.seed) await opts.seed(mine);
      const { page, context } = await device({ ...opts, token });
      await page.goto('/');
      await expect(page.getByText('Groups', { exact: true }).first()).toBeVisible();
      return { name, token, userId: user.id, page, context, api: mine };
    });
  },
});

export { expect };
