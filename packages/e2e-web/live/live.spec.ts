/**
 * The hosted app, checked from outside the way a person reaches it: the API
 * is up with real payments and still asks for a sign-in, the web app and its
 * deep links load, and one account can be made, split a bill, see it in the
 * app, and be deleted again.
 *
 * Production has real people on it. Every test here only reads, except the
 * last, which makes an account of its own ("Live check"), a group where it is
 * the only account, and one expense, and deletes the account at the end
 * whatever happens. Deleting it deletes that group with it
 * (apps/api/src/routes/accounts.ts). No payment is ever started.
 */

import { expect, test } from '@playwright/test';

import { Api } from '../src/api';
import { WELCOME } from '../src/actions';
import { TIPS_SEEN } from '../src/fixtures';
import { LIVE_API_URL, LIVE_WEB_URL } from './env';

/** The tour's first page, which a brand-new device sees around the name question. */
const TOUR = 'Split bills without the maths';

let api: Api;

test.beforeAll(async () => {
  api = await Api.create(LIVE_API_URL);
});

test.afterAll(async () => {
  await api?.dispose();
});

test('the API is up, with real payments', async () => {
  const health = await api.raw<{ ok: boolean; payments: string }>('GET', '/health');
  expect(health.status).toBe(200);
  expect(health.body).toEqual({ ok: true, payments: 'real' });
});

test('the API turns away a request without a sign-in', async () => {
  const answer = await api.raw('GET', '/groups', undefined, { token: null });
  expect(answer.status).toBe(401);
});

test('the web app opens on its first screen, without a script error', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  // The tour or the name question, whichever this release opens on.
  await expect(page.getByText(TOUR).or(page.getByText(WELCOME)).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('deep links load the app, and /privacy is the policy', async ({ page }) => {
  for (const path of ['/s/live-check', '/g/live-check', '/join/live-check', '/restore']) {
    const deep = await page.request.get(path);
    expect(deep.status(), path).toBe(200);
    expect(deep.headers()['content-type'], path).toContain('text/html');
  }
  const policy = await page.request.get('/privacy');
  expect(policy.status()).toBe(200);
  expect(await policy.text()).not.toContain('<div id="root">');
});

test('an account splits a bill, sees it in the app, and is deleted again', async ({ browser }) => {
  const name = 'Live check';
  const groupName = `Live check ${new Date().toISOString().slice(0, 16)}`;
  const { token } = await api.account(name);
  const me = api.as(token);
  try {
    // The maker is the group's first member and its only account; Ghost is a name, not a person.
    const { group, idOf } = await me.seedGroup({
      name: groupName,
      people: ['Ghost'],
      currency: 'INR',
      spends: [{ description: 'Live check', amount: 10_000, paidBy: name }],
    });
    const debts = await me.debts(group.id);
    expect(debts).toHaveLength(1);
    expect(debts[0]).toMatchObject({ fromMemberId: idOf('Ghost'), toMemberId: idOf(name), amount: 5_000 });

    // The web app, signed in as that account, shows the group.
    const context = await browser.newContext({
      storageState: {
        cookies: [],
        origins: [
          {
            origin: LIVE_WEB_URL,
            localStorage: [
              { name: 'sattle.token', value: token },
              { name: 'sattle.toured', value: '1' },
              { name: 'sattle.tips', value: TIPS_SEEN },
              { name: 'sattle.getPaidDone', value: '1' },
            ],
          },
        ],
      },
    });
    try {
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.getByText(groupName)).toBeVisible();
    } finally {
      await context.close();
    }
  } finally {
    // Whatever failed above, the account and its group don't stay on production.
    const gone = await me.raw('DELETE', '/me');
    expect(gone.status, 'deleting the live check account').toBe(200);
  }
  expect((await me.raw('GET', '/me')).status).toBe(401);
});
