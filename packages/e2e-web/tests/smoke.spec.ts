/**
 * The two ways a test starts, exercised once: a brand-new device walking in
 * from the tour, and a person the fixtures signed in. If these fail, nothing
 * else in this folder is worth reading.
 */

import { makeAccount, skipTour } from '../src/actions';
import { expect, test } from '../src/fixtures';

test('a brand-new device gets the tour, then makes an account', async ({ device }) => {
  const { page } = await device({ toured: false });
  await page.goto('/');
  await skipTour(page);
  await expect(page.getByText('What should your friends call you?')).toBeVisible();
  await makeAccount(page, 'Yash');
});

test('a person the fixtures signed in is on their groups list, and is who the server says', async ({ person }) => {
  const yash = await person('Yash');
  await expect(yash.page.getByText('What are you splitting?')).toBeVisible();
  expect((await yash.api.me()).displayName).toBe('Yash');
});

test('the web app is served the way nginx serves it: deep links load the app, /privacy is the policy', async ({ page }) => {
  const deep = await page.request.get('/s/some-token');
  expect(deep.status()).toBe(200);
  expect(deep.headers()['content-type']).toContain('text/html');
  const policy = await page.request.get('/privacy');
  expect(policy.status()).toBe(200);
  expect(await policy.text()).not.toContain('<div id="root">');
});
