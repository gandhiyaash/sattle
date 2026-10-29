/**
 * The device and the address bar: what each kind of link opens on a phone
 * that has nothing stored and on one that is signed in, the app with the
 * server unreachable, a browser that blocks storage, and the app on a
 * laptop's screen instead of a phone's.
 */

import { devices } from '@playwright/test';

import { button, groupHeader, makeAccount, skipTour } from '../src/actions';
import { expect, test } from '../src/fixtures';

const API = (url: URL) => url.hostname === '127.0.0.1' && url.port === '3900';

test.describe('links on a brand-new device', () => {
  test('a pay link that isn’t one', async ({ device }) => {
    const { page } = await device({ toured: false });
    await page.goto('/s/nope');
    await expect(page.getByText('This link isn’t valid')).toBeVisible();
    await expect(page.getByText('Check you copied all of it, or ask whoever sent it for a new one.')).toBeVisible();
    await expect(page.getByText('Split bills without the maths')).toHaveCount(0);
  });

  test('a group link that isn’t one', async ({ device }) => {
    const { page } = await device({ toured: false });
    await page.goto('/g/nope');
    await expect(page.getByText('This link is no longer valid.')).toBeVisible();
    await expect(page.getByText('Try again')).toHaveCount(0);
    await expect(page.getByText('Split bills without the maths')).toHaveCount(0);
  });

  test('a join link that isn’t one: the tour, then the news, then the app without it', async ({ device }) => {
    const { page } = await device({ toured: false });
    await page.goto('/join/nope');
    await skipTour(page);
    await expect(page.getByText('This link is no longer valid.')).toBeVisible();
    await expect(page.getByText('Try again')).toHaveCount(0);
    await button(page, 'Start without it').click();
    await expect(page.getByText('What should your friends call you?')).toBeVisible();
    // The used link is off the address bar, so a reload opens the app and not the link.
    await expect(page).toHaveURL(/\/$/);
    await page.reload();
    await expect(page.getByText('What should your friends call you?')).toBeVisible();
  });

  test('a token with an encoded slash in it is sent as it was typed, and refused', async ({ device }) => {
    const { page } = await device();
    const asked: string[] = [];
    page.on('request', (r) => {
      if (API(new URL(r.url()))) asked.push(new URL(r.url()).pathname);
    });
    await page.goto('/g/a%2Fb');
    await expect(page.getByText('This link is no longer valid.')).toBeVisible();
    expect(asked).toContain('/g/a%2Fb');
  });

  test('any other path is the app', async ({ device, api }) => {
    const { page } = await device();
    await page.goto('/whatever/this/is?x=1');
    await expect(page.getByText('What should your friends call you?')).toBeVisible();

    const { token } = await api.account('Deep');
    const signedIn = await device({ token });
    await signedIn.page.goto('/nothing/here');
    await expect(signedIn.page.getByText('No groups yet')).toBeVisible();
  });

  test('/privacy is the policy page, served as it is', async ({ device }) => {
    const { page } = await device({ toured: false });
    await page.goto('/privacy');
    await expect(page).toHaveTitle('Sattle Privacy Policy');
    await expect(page.getByRole('heading', { name: 'Privacy Policy' })).toBeVisible();
    await expect(page.getByText('Split bills without the maths')).toHaveCount(0);
  });
});

test.describe('links on a device that is signed in', () => {
  test('the join link of a group you are in opens the group', async ({ person }) => {
    const { page, api } = await person('Yash');
    const { group } = await api.seedGroup({ name: 'Weekend', people: ['Riya'] });
    const link = await api.createGroupLink(group.id);
    await page.goto(`/join/${link.token}`);
    await expect(page.getByText('Weekend', { exact: true })).toBeVisible();
    await expect(groupHeader(page)).toHaveText('2 members · 0 expenses');
    await expect(page.getByText('Join a group')).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
  });

  test('the group link opens the group’s page, as it would for anyone', async ({ person }) => {
    const { page, api } = await person('Yash');
    const { group } = await api.seedGroup({
      name: 'Weekend',
      people: ['Riya'],
      spends: [{ description: 'Fuel', amount: 90_000, paidBy: 'Yash' }],
    });
    const link = await api.createGroupLink(group.id);
    await page.goto(`/g/${link.token}`);
    await expect(page.getByText('Weekend', { exact: true })).toBeVisible();
    await expect(page.getByText('1 spend · shared by link')).toBeVisible();
    await expect(page.getByText('Riya owes Yash')).toBeVisible();
    const join = page.getByRole('link', { name: 'Join group' });
    await expect(join).toHaveAttribute('href', `/join/${link.token}`);
    await expect(page.getByText('Manage', { exact: true })).toHaveCount(0);
  });
});

test.describe('the server out of reach', () => {
  test('the groups list says so, and Try again reads it once the server is back', async ({ device, api }) => {
    const { token } = await api.account('Yash');
    await api.as(token).createGroup({ name: 'Goa', memberNames: ['Om'] });
    const { page } = await device({ token });
    await page.route(API, (route) => route.abort('connectionrefused'));
    await page.goto('/');
    await expect(page.getByText('Couldn’t reach the server. Check your connection and try again.')).toBeVisible();
    await expect(button(page, 'Try again')).toBeVisible();
    // The token is kept: being offline is no reason to sign anyone out.
    expect(await page.evaluate(() => localStorage.getItem('sattle.token'))).toBe(token);

    await button(page, 'Try again').click();
    await expect(page.getByText('Couldn’t reach the server. Check your connection and try again.')).toBeVisible();

    await page.unroute(API);
    await button(page, 'Try again').click();
    await expect(page.getByText('Goa', { exact: true })).toBeVisible();
    await expect(page.getByText('Couldn’t reach the server', { exact: false })).toHaveCount(0);
  });

  test('the welcome screen says so, and the name is still there to try again with', async ({ device }) => {
    const { page } = await device();
    await page.goto('/');
    await page.route(API, (route) => route.abort('connectionrefused'));
    await page.getByPlaceholder('Your name').fill('Yash');
    await button(page, 'Get started').click();
    await expect(page.getByText('Couldn’t reach the server. Check your connection and try again.')).toBeVisible();
    await expect(page.getByPlaceholder('Your name')).toHaveValue('Yash');
    expect(await page.evaluate(() => localStorage.getItem('sattle.token'))).toBeNull();

    await page.unroute(API);
    await button(page, 'Get started').click();
    await expect(page.getByText('No groups yet')).toBeVisible();
  });
});

test.describe('a browser that blocks storage', () => {
  test('the account works until the tab closes, and is gone after', async ({ device }) => {
    const { page, context } = await device();
    await context.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException('blocked', 'SecurityError');
      };
    });
    await page.goto('/');
    await makeAccount(page, 'Yash');
    await button(page, 'New group').click();
    await expect(page.getByPlaceholder('Goa trip')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('sattle.token'))).toBeNull();

    await page.reload();
    await expect(page.getByText('What should your friends call you?')).toBeVisible();
  });
});

test.describe('hand-offs to other apps', () => {
  test('a UPI link the browser can’t open leaves the page where it was', async ({ api, device }) => {
    const payee = await api.account('Priya');
    await api.as(payee.token).setUpiId('priya@okaxis');
    const { group } = await api.as(payee.token).seedGroup({
      name: 'Dinner',
      people: ['Alice'],
      spends: [{ description: 'Pizza', amount: 60_000, paidBy: 'Priya' }],
    });
    const link = await api.as(payee.token).createGroupLink(group.id);
    const { page } = await device();
    await page.goto(`/g/${link.token}`);
    await button(page, 'Pay by UPI').click();
    await expect(page.getByText('priya@okaxis', { exact: true })).toBeVisible();
    const open = button(page, 'Open a UPI app on this phone');
    await expect(open).toBeVisible();
    await open.click();
    // The scheme is nobody's here. The page stays, with the ID still on it to pay by hand.
    await expect(page.getByText('priya@okaxis', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/g/${link.token}$`));
    await expect(button(page, 'I’ve paid')).toBeVisible();
  });
});

// The browser is the same; only in a describe the device's browser type can't be named again.
const { defaultBrowserType: _sameBrowser, ...laptop } = devices['Desktop Chrome'];

test.describe('on a laptop', () => {
  test.use({ ...laptop, viewport: { width: 1400, height: 900 } });

  test('the app stays a phone’s column in the middle of the window', async ({ person }) => {
    const { page } = await person('Yash');
    const column = await page.evaluate(() => {
      const el = [...document.querySelectorAll('#root *')].find((e) => getComputedStyle(e).maxWidth === '720px');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, width: r.width, window: window.innerWidth };
    });
    expect(column).not.toBeNull();
    expect(column!.width).toBeLessThanOrEqual(720);
    expect(column!.width).toBeGreaterThan(600);
    expect(Math.abs(column!.left - (column!.window - column!.width) / 2)).toBeLessThan(2);
  });

  test('UPI shows a code to scan, and no button to open an app this computer hasn’t got', async ({ api, device }) => {
    const payee = await api.account('Priya');
    await api.as(payee.token).setUpiId('priya@okaxis');
    const { group } = await api.as(payee.token).seedGroup({
      name: 'Dinner',
      people: ['Alice'],
      spends: [{ description: 'Pizza', amount: 60_000, paidBy: 'Priya' }],
    });
    const link = await api.as(payee.token).createGroupLink(group.id);
    const { page } = await device();
    await page.goto(`/g/${link.token}`);
    await button(page, 'Pay by UPI').click();
    await expect(page.getByText('priya@okaxis', { exact: true })).toBeVisible();
    await expect(page.getByText('Scan with any UPI app.')).toBeVisible();
    await expect(page.locator('svg').first()).toBeVisible();
    await expect(button(page, 'Open a UPI app on this phone')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy UPI ID' })).toBeVisible();
  });
});
